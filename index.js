/**
 * dsh-sticker-library —— 给 Agent 一个「表情包架子」。
 *
 * 它要解决的不是「存表情包」，而是四件经常被做错的事（细节见 `src/shelf.js` 的注释）：
 *   1. 什么算表情包（别拿 `summary === '[图片]'` 去认，那会把群友的真人照片收进库）
 *   2. 怎么算「懂」这张图（别用固定标签表，让视觉模型自己写"画的是什么 / 什么场合发 / 关键词"）
 *   3. 删了就得真删干净（内容哈希进黑名单，否则同一张图再被发一次会被原样收回来）
 *   4. 两条安全线：脏（脏话/性暗示）和烂（低质烂梗）—— 入库那一刻拦掉，不指望下游每次都记得
 *
 * 出口：
 *   · 一组 `sticker_*` 工具 —— Agent 自己调（看清单、挑一张、收图、打标）
 *   · `stickerShelf` 服务 —— 别的插件也能用（通道插件收到贴图时喂进来，发消息时挑一张）
 *
 * 打标需要一个「看得见」的模型。默认走**任何 OpenAI 兼容**的 `/chat/completions`
 * （配 `vision.baseUrl` / `vision.apiKey` / `vision.model`），也可以用 `describeCommand`
 * 挂一条本地命令。没有视觉模型也能用：库照收、清单照出，只是挑图的准头差一截。
 *
 * @module dsh-sticker-library
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { createShelf, DEFAULT_TAG_PROMPT, TAG_VER } from './src/shelf.js'

/** Cordis 插件名。 */
export const name = 'dsh-sticker-library'

/** 需要的能力：注册工具。 */
export const inject = ['tools']

const DEFAULTS = {
  /** 图片存哪（会自动建）。默认工作目录下的 `.stickers/` */
  dir: process.env.STICKER_DIR || join(process.cwd(), '.stickers'),
  /** 视觉模型：任何 OpenAI 兼容的 /chat/completions（要支持 image_url 的 data: base64） */
  vision: {
    baseUrl: process.env.STICKER_VISION_BASE || 'https://api.openai.com/v1',
    apiKey: process.env.STICKER_VISION_KEY || process.env.OPENAI_API_KEY || '',
    model: process.env.STICKER_VISION_MODEL || 'gpt-4o-mini',
  },
  /**
   * 也可以不用 HTTP，改挂一条命令：`my-describe <图片路径> <提示词>`，结果打到 stdout。
   * 本地跑视觉模型、或者想复用自己那套脚本时用这个（设了它就不走上面那套）。
   */
  describeCommand: process.env.STICKER_DESCRIBE_CMD || '',
  /** 一次最多给几张打标（每张一次模型调用，按钱算） */
  tagLimit: 15,
  /** 库上限 / 大小闸 */
  maxItems: 500,
  maxBytes: 4 * 1024 * 1024,
  minBytes: 1024,
  /** `sticker_catalog` 一次最多列几张 */
  catalogLimit: 40,
  /** 打标提示词（默认 {@link DEFAULT_TAG_PROMPT}） */
  prompt: '',
  timeoutMs: 60_000,
}

export function apply(ctx, rawConfig) {
  const config = { ...DEFAULTS, ...(rawConfig ?? {}), vision: { ...DEFAULTS.vision, ...((rawConfig && rawConfig.vision) || {}) } }

  // 直接写 stderr，不走 ctx.logger —— cordis 的 logger 默认只挂一个内存环形缓冲，
  // info 既不落文件也不上屏，插件看着像根本没加载。
  const log = (...args) => {
    try {
      process.stderr.write(`${new Date().toISOString()} [dsh-sticker-library] ${args.join(' ')}\n`)
    } catch {
      // stderr 都没了就算了
    }
  }

  // ---------------- 打标签用的「看」：两种接法 ----------------
  // 命令可以带参数（`node /path/x.js`），但**不过 shell** —— 拆成 [bin, ...args] 直接 execFile，
  // 免得配置里一个引号就把整条命令交给 shell 解释。
  const describeByCommand = (command) => {
    const parts = String(command).trim().split(/\s+/)
    const bin = parts[0]
    const pre = parts.slice(1)
    return async (file, prompt) => {
      const out = execFileSync(bin, [...pre, file, prompt], { timeout: config.timeoutMs, maxBuffer: 1 << 20 })
      return String(out || '')
    }
  }

  const describeByHttp = async (file, prompt) => {
    const { baseUrl, apiKey, model } = config.vision
    if (!apiKey) throw new Error('没配视觉模型的 apiKey（vision.apiKey / STICKER_VISION_KEY / OPENAI_API_KEY）')
    const buf = readFileSync(file)
    const ext = String(file).toLowerCase().endsWith('.png') ? 'png' : String(file).toLowerCase().endsWith('.gif') ? 'gif' : 'jpeg'
    const body = {
      model,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: `data:image/${ext};base64,${buf.toString('base64')}` } },
          ],
        },
      ],
      max_tokens: 400,
    }
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), config.timeoutMs)
    try {
      const res = await fetch(`${String(baseUrl).replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
        signal: ac.signal,
      })
      if (!res.ok) throw new Error(`视觉接口 ${res.status}：${(await res.text()).slice(0, 200)}`)
      const json = await res.json()
      const text = json?.choices?.[0]?.message?.content
      if (typeof text !== 'string') throw new Error('视觉接口没给 content')
      return text
    } finally {
      clearTimeout(timer)
    }
  }

  const describe = config.describeCommand
    ? describeByCommand(String(config.describeCommand))
    : describeByHttp

  const shelf = createShelf({
    dir: resolve(String(config.dir)),
    describe,
    prompt: config.prompt || DEFAULT_TAG_PROMPT,
    maxItems: config.maxItems,
    maxBytes: config.maxBytes,
    minBytes: config.minBytes,
    log: (...a) => log(...a),
  })

  // ---------------- 出口一：工具 ----------------
  ctx.tools.register({
    name: 'sticker_catalog',
    description:
      '列出表情包架子里的图（每行一条：编号 · 画的是什么 · 什么场合发 · 关键词）。想发表情包之前先看这个，再按编号或关键词挑。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        limit: { type: 'integer', description: '最多列几张，默认跟配置走（通常 40）。' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', description: '清单文本；库是空的就是一句说明。' },
          count: { type: 'integer', description: '库里能用的图共几张。' },
        },
        required: ['text', 'count'],
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const limit = Number(args?.limit) > 0 ? Number(args.limit) : config.catalogLimit
      const stats = shelf.stats()
      const text = shelf.catalog(limit)
      // 空库不能回一句空字符串：Agent 收到空文本只会困惑。说清"为什么空、下一步干什么"。
      return {
        text: text.trim()
          ? text
          : `架子还是空的（共 ${stats.total} 张，能用 ${stats.usable} 张，没打标 ${stats.untagged} 张）。先收图、再打标，才能挑。`,
        count: stats.usable,
      }
    },
  })

  ctx.tools.register({
    name: 'sticker_pick',
    description:
      '从表情包架子里挑一张，返回它的本地文件路径（拿去当图片发）。可以给编号（#12 / 12）、也可以给含义关键词（猫 / 无语 / 摆烂）。挑不到就老实说挑不到，别硬凑。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: '编号或关键词；写「随便」= 随便来一张。' },
      },
      required: ['query'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', description: '挑到没有。' },
          path: { type: 'string', description: '挑到的图片本地路径。' },
          id: { type: 'integer', description: '编号。' },
          desc: { type: 'string', description: '这张画的是什么。' },
          note: { type: 'string', description: '没挑到时说明原因。' },
        },
        required: ['ok'],
      },
      render: (_args, v) => [
        {
          type: 'text',
          text: v.ok ? `挑了 #${v.id}：${v.desc || ''}\n文件：${v.path}` : `没挑到（${v.note || '库里没有对得上的'}）`,
        },
      ],
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const query = String(args?.query ?? '').trim()
      if (!query) return { ok: false, note: '没给关键词。' }
      const hit = shelf.resolve(query)
      if (!hit) return { ok: false, note: `没有对得上「${query}」的图（别硬发一张不相干的）。` }
      return { ok: true, path: hit.path, id: hit.id, desc: hit.desc || '' }
    },
  })

  ctx.tools.register({
    name: 'sticker_save',
    description:
      '把本地图片文件收进表情包架子（去重、挡黑名单、认烂梗）。通道收到别人发的贴图之后，把图下载到本地再调它；也可以用来自某个目录批量倒图。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        paths: { type: 'array', items: { type: 'string' }, description: '一个或多个本地图片路径。' },
        nick: { type: 'string', description: '谁发的（只用于记档）。' },
        uid: { type: 'string', description: '发送者 id（只用于记档）。' },
      },
      required: ['paths'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          added: { type: 'integer', description: '新收下几张。' },
          seen: { type: 'integer', description: '几张之前就见过（只更新次数）。' },
          skipped: { type: 'integer', description: '几张跳过（太小/太大/认不出格式/在黑名单里）。' },
        },
        required: ['added', 'seen', 'skipped'],
      },
      render: (_args, v) => [
        { type: 'text', text: `收图：新收 ${v.added} 张，见过 ${v.seen} 张，跳过 ${v.skipped} 张。` },
      ],
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const list = (Array.isArray(args?.paths) ? args.paths : [])
        .map((p) => (isAbsolute(String(p)) ? String(p) : resolve(String(p))))
        .filter((p) => p && existsSync(p) && statSync(p).isFile())
      if (!list.length) return { added: 0, seen: 0, skipped: 0 }
      return shelf.saveFiles(list, { nick: args?.nick, uid: args?.uid })
    },
  })

  ctx.tools.register({
    name: 'sticker_tag',
    description:
      '给还没打标的图打标（用视觉模型写「画的是什么 / 什么场合发 / 关键词」，顺便判脏和烂梗）。收完新图之后调一次。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        limit: { type: 'integer', description: '这次最多打几张，默认跟配置走（通常 15）。' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          tagged: { type: 'integer', description: '这次打了几张。' },
          left: { type: 'integer', description: '还剩几张没打。' },
          blocked: { type: 'integer', description: '被安全线拦下的（烂梗/脏）。' },
        },
        required: ['tagged', 'left'],
      },
      render: (_args, v) => [
        { type: 'text', text: `打标 ${v.tagged} 张，还剩 ${v.left} 张没打${v.blocked ? `（拦下 ${v.blocked} 张）` : ''}。` },
      ],
    },
    isConcurrencySafe: () => false,
    async execute(args) {
      const limit = Number(args?.limit) > 0 ? Number(args.limit) : config.tagLimit
      const tagged = await shelf.tagPending(limit)
      const s = shelf.stats()
      return { tagged, left: s.untagged, blocked: s.blocked }
    },
  })

  ctx.tools.register({
    name: 'sticker_forget',
    description: '从表情包架子删掉一张（真删文件 + 内容哈希进黑名单，同一张再被发也不会收回来）。不知道编号就先看 `sticker_catalog`。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'integer', description: '要删的编号。' },
        why: { type: 'string', description: '为什么删（记进黑名单备注）。' },
      },
      required: ['id'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', description: '删掉没有。' },
          note: { type: 'string', description: '没删成的原因。' },
        },
        required: ['ok'],
      },
      render: (_args, v) => [{ type: 'text', text: v.ok ? '已删（文件真删了，哈希进了黑名单）' : `没删成：${v.note || '没这张'}` }],
    },
    isConcurrencySafe: () => false,
    async execute(args) {
      const r = shelf.remove(args?.id, args?.why)
      return r.ok ? { ok: true } : { ok: false, note: r.reason || '库里没这个编号' }
    },
  })

  // ---------------- 出口二：给别的插件用的服务 ----------------
  try {
    ctx.provide('stickerShelf', {
      dir: shelf.dir,
      catalog: (limit) => shelf.catalog(limit),
      resolve: (query) => shelf.resolve(query),
      saveFiles: (paths, meta) => shelf.saveFiles(paths, meta),
      tagPending: (limit) => shelf.tagPending(limit),
      remove: (id, why) => shelf.remove(id, why),
      renumber: () => shelf.renumber(),
      stats: () => shelf.stats(),
      get: (id) => shelf.get(id),
    })
  } catch (error) {
    log('暴露 stickerShelf 失败（不影响工具本身）：', String(error))
  }

  const s = shelf.stats()
  log(`就绪：目录=${shelf.dir} 库=${s.total} 张（能用 ${s.usable}、没打标 ${s.untagged}、拦下 ${s.blocked}）TAG_VER=${TAG_VER} 打标=${config.describeCommand ? '命令' : config.vision.model}`)
  if (shelf.dir === join(process.cwd(), '.stickers') && !existsSync(shelf.dir)) {
    log('提示：没配 dir，用的是工作目录下的 .stickers/。想固定位置就设 STICKER_DIR 或 config.dir。')
  }
}
