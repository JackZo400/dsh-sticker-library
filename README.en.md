# dsh-sticker-library

[简体中文](README.md) | English

A **chat sticker library** for
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh): collect images
with dedupe, let a vision model tag them itself, pick stickers by meaning - plus two
safety lines.

It is not "put the images into a folder" - `mkdir` is enough for that. What it handles
is the four steps of **making an Agent actually use stickers** that are easiest to get
wrong.

> **More mature options in the same space**: [yyh-001/dsh-meme](https://github.com/yyh-001/dsh-meme) and
> [william-jin-cmu/dsh-stickers](https://github.com/william-jin-cmu/dsh-stickers) are both older and more
> established than this one; look at them first if you are choosing.
> Why we keep this one: **dedupe on save + vision tagging + two safety lines** - profanity and low-quality
> meme material are blocked at the moment they are saved, instead of counting on the downstream model to
> remember every time.
> It is the set our own group chat runs, published as it is.

## Why you need it

**Why build this as a separate thing.**

**1. What counts as a sticker.**
Recognizing them with heuristics like `summary === '[图片]'` pulls the **real photos,
screenshots and stickers** your group members send into one bin. Only stickers the
protocol explicitly marks (OneBot's `emoji_id` / `sub_type=1` and the like) get in;
everything else stays out.

**2. What counts as "understanding" an image.**
A fixed tag table is the least effort and the least useful approach: we tried 40 fixed
words, and 40-plus images got flattened into three classes - "cute / acting cute /
speechless" - which makes picking a sticker basically random. Let the vision model write
three lines itself - **what is drawn / when to send it / keywords** - and only then can
it really pick. Text in the image must be **copied verbatim**, because half a sticker's
meaning lives in that line.

**3. Deleting must really delete.**
Dropping the entry from the index is useless: dedupe looks at the **content hash**, so
when the same image is sent again, it is pulled right back in. So deleting always means
"delete the file + add the content hash to the blocklist".

**4. Two safety lines.**
`脏` (profanity / sexual innuendo / obscenity) and `烂` (low-quality
overused-meme material). Both are blocked **at the moment they are saved**; we do not
count on the downstream model to remember not to send them every time - it forgets, and
it does not understand what that means.

## Install

```bash
npm i dsh-sticker-library
# 或者直接 clone 到你的插件目录，然后在 bundle patch 里 insert（见 cordis.patch.yml）
```

The example config in `cordis.patch.yml` can be copied as is.

## Configuration (the tagging path)

Tagging needs a model that can "see". There are two ways to hook one up; pick one:

**A. HTTP (any OpenAI-compatible `/chat/completions`, and it must support `image_url`
with `data:` base64)**

```yaml
config:
  vision:
    baseUrl: https://api.openai.com/v1
    apiKey: ''            # 建议用环境变量 STICKER_VISION_KEY
    model: gpt-4o-mini    # DeepSeek 官方视觉模型 / qwen-vl 都行
```

**B. A single command** (run a vision model locally, or reuse a script you already
have):

```yaml
config:
  describeCommand: 'node /path/to/describe.js'   # 参数：<图片路径> <提示词>，结果打到 stdout
```

**It works with neither of them configured too**: images are still collected and the
catalog is still produced, only the picking is a notch less accurate (the catalog has no
"what is drawn" in it).

> Tip: base64-ing a large image and sending it costs a lot of tokens. In production we
> downscale it to 768 on the long edge before sending - one line of Pillow does that,
> and it is not done for you here because we did not want to tie you to a Python
> dependency just to save a fraction of a cent.

## Usage (tools for the Agent)

| Tool | What it does |
| --- | --- |
| `sticker_catalog` | List the catalog: `#3 · 一只橘猫趴在键盘上 · 别人发疯时围观 · 猫/围观/无语` |
| `sticker_pick` | Pick one and return its local path. An index (`#12`) or a keyword (`无语`) both work |
| `sticker_save` | Save a local image into the library (the channel feeds it in after downloading a sticker) |
| `sticker_tag` | Tag whatever is not tagged yet (call it once after collecting new images) |
| `sticker_forget` | Delete one: really delete the file + put the hash on the blocklist |

When `sticker_pick` cannot find anything it **says so plainly** instead of forcing an
unrelated image on you - that detail matters more than it looks: a picker that "hands
you something random" is one nobody dares let send images after two tries.

## Usage (the service other plugins use)

```js
const shelf = ctx.stickerShelf
shelf.catalog(40)                      // 清单文本
shelf.resolve('无语')                   // { id, file, path, desc, ... } | null
shelf.saveFiles(paths, { nick, uid })  // 协议无关的入库口
shelf.stats()
```

The core logic (`src/shelf.js`) **depends on neither dsh nor any IM protocol**, so it
can be used on its own:

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

## Tests

```bash
node test/selftest.mjs
```

No network, no model calls, no private directories: the vision model and the downloads
are fake. What it tests is the **parsing and the safety lines** (dedupe, blocklist, size
gate, overused-meme blocking, all three routes for adult images closed, the
protocol-agnostic save entry point, ...). 84 items.

## Known limitations (what it does not do)

- It does not send. It picks one out and gives you a path; how to send it is your
  business - and whose review it has to pass the moment it goes out should be your
  decision too.
- It does not decide "what counts as dirty" for you. Those two lines in the prompt are
  editable (the `prompt` config); when you change them, remember to bump `TAG_VER` along
  with them, or old images will not be re-tagged.
- No distributed/concurrent writes. One directory, one shelf.

## License

MIT
