/**
 * 插件入口的自检 —— **不需要 dsh**：拿一个假 ctx 把 `apply()` 跑起来，
 * 然后把注册出来的工具一个个真调一遍。测的是接线（工具注册了没、schema 合法不合法、
 * 参数不合法时会不会炸），不是 shelf 的逻辑（那个归 test/selftest.mjs）。
 *
 *   node test/plugin-selftest.mjs
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, name as pluginName, inject } from '../index.js'

let pass = 0
const fails = []
const ok = (n, cond, extra) => { if (cond) pass++; else fails.push(n + (extra ? '  → ' + extra : '')) }
const eq = (n, got, want) => ok(n, got === want, `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`)

const root = mkdtempSync(join(tmpdir(), 'sticker-plugin-'))
const dir = join(root, 'shelf')

// 假的「看」：一条本地命令，把五行写死打到 stdout（describeCommand 那条路）
const fakeVision = join(root, 'vision.cjs')
writeFileSync(fakeVision, `
const p = process.argv[2]
const fs = require('fs')
if (!fs.existsSync(p)) { console.error('no file'); process.exit(2) }
process.stdout.write('看：一只橘猫趴在键盘上\\n用：别人发疯时围观\\n词：猫, 围观, 无语\\n脏：无\\n烂：无\\n')
`)

// 假的 ctx
const tools = new Map()
const provided = {}
const ctx = {
  tools: { register: (t) => tools.set(t.name, t) },
  provide: (k, v) => { provided[k] = v },
  effect: () => {},
}

eq('插件名对', pluginName, 'dsh-sticker-library')
eq('要 tools 能力', JSON.stringify(inject), JSON.stringify(['tools']))

apply(ctx, { dir, describeCommand: `node ${fakeVision}`, tagLimit: 5 })

ok('注册了 sticker_catalog', tools.has('sticker_catalog'))
ok('注册了 sticker_pick', tools.has('sticker_pick'))
ok('注册了 sticker_save', tools.has('sticker_save'))
ok('注册了 sticker_tag', tools.has('sticker_tag'))
ok('注册了 sticker_forget', tools.has('sticker_forget'))
ok('暴露了 stickerShelf 服务', !!provided.stickerShelf)
ok('每个工具都有 description', [...tools.values()].every((t) => typeof t.description === 'string' && t.description.length > 10))
ok('每个工具的 output.schema 都在', [...tools.values()].every((t) => t.output && t.output.schema))
// dsh 只收 JSON Schema 的一个子集：required 必须是 object 上的字符串数组（写成 true 会被拒）
ok(
  'required 全是字符串数组（dsh 的方言）',
  [...tools.values()].every((t) => {
    const req = [t.parameters, t.output.schema].filter(Boolean).map((s) => s.required).filter((r) => r !== undefined)
    return req.every((r) => Array.isArray(r) && r.every((x) => typeof x === 'string'))
  }),
)

const call = (tool, args) => tools.get(tool).execute(args, {})

// ① 空库：清单不炸、挑图老实说挑不到
{
  const c = await call('sticker_catalog', {})
  eq('空库清单是空的', c.count, 0)
  ok('空库清单有一句说明', typeof c.text === 'string' && c.text.length > 0)
  const p = await call('sticker_pick', { query: '猫' })
  eq('空库挑不到 → ok=false', p.ok, false)
  ok('挑不到会说明原因', typeof p.note === 'string' && p.note.length > 0)
}

// ② 存一张 → 打标 → 清单里能看见 → 按关键词挑得到
{
  // 插件默认 minBytes = 1024（挡 icon 那种几十字节的垃圾），所以假图要给够大小
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(4000, 1)])
  const file = join(root, 'cat.png')
  writeFileSync(file, png)

  const saved = await call('sticker_save', { paths: [file], nick: '阿猫' })
  eq('存进 1 张', saved.added, 1)
  eq('跳过的 0 张', saved.skipped, 0)

  const t = await call('sticker_tag', {})
  eq('打标 1 张', t.tagged, 1)
  eq('没有剩下的', t.left, 0)

  const c = await call('sticker_catalog', {})
  eq('清单里有 1 张', c.count, 1)
  ok('清单里带着「看」的内容', c.text.includes('橘猫'))
  // 五行是**分行解析**的：desc 只该是第一行的内容，不该把「用/词/脏/烂」一起吃进来
  eq('描述解析成一行', provided.stickerShelf.get(1).desc, '一只橘猫趴在键盘上')
  ok('关键词也解析出来了', (provided.stickerShelf.get(1).tags || []).includes('猫'))
  eq('脏=无 → not adult', !!provided.stickerShelf.get(1).adult, false)

  const p = await call('sticker_pick', { query: '猫' })
  eq('按关键词挑到了', p.ok, true)
  ok('返回的是真路径', !!p.path && existsSync(p.path))
  eq('编号是 1', p.id, 1)

  const byId = await call('sticker_pick', { query: '#1' })
  eq('按编号也挑得到', byId.id, 1)

  const none = await call('sticker_pick', { query: '量子力学串烧' })
  eq('对不上的关键词 → 不硬凑', none.ok, false)

  // ③ 删掉：真删 + 挑不到
  const del = await call('sticker_forget', { id: 1, why: '自检' })
  eq('删掉了', del.ok, true)
  const after = await call('sticker_pick', { query: '猫' })
  eq('删完挑不到', after.ok, false)
  eq('清单也空了', (await call('sticker_catalog', {})).count, 0)
  const delAgain = await call('sticker_forget', { id: 1 })
  eq('删不存在的编号 → ok=false 不炸', delAgain.ok, false)
}

// ④ 参数不合法不能炸
{
  eq('save 空数组不炸', JSON.stringify(await call('sticker_save', { paths: [] })), JSON.stringify({ added: 0, seen: 0, skipped: 0 }))
  eq('save 路径不存在 → 全跳过', (await call('sticker_save', { paths: ['/nope/none.png'] })).added, 0)
  eq('pick 空 query → ok=false', (await call('sticker_pick', { query: '   ' })).ok, false)
  const noArgs = await call('sticker_pick', undefined)
  eq('pick 无参不炸', noArgs.ok, false)
}

rmSync(root, { recursive: true, force: true })

if (fails.length) {
  console.log(`❌ ${fails.length} 项没过（过 ${pass} 项）：`)
  for (const f of fails) console.log('  · ' + f)
  process.exit(1)
}
console.log(`✅ 全过：${pass} 项`)
