/**
 * 自带语料的自检 —— 不联网、不调模型、不依赖任何私人目录。
 * 目标是：clone 下来 `node test/selftest.mjs` 就能跑，而且**真的断言**（不是打印一堆 OK）。
 *
 * 视觉模型是假的：按调用顺序返回写死的五行文本 —— 这样测的是解析和安全线，不是模型的脾气。
 * 下载也是假的 —— 我们只关心"给一段字节，库里会发生什么"。
 *
 *   node test/selftest.mjs
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createShelf, TAG_VER } from '../src/shelf.js'

let pass = 0
const fails = []
function ok(name, cond, extra) {
  if (cond) pass++
  else fails.push(name + (extra ? '  → ' + extra : ''))
}
const eq = (name, got, want) => ok(name, got === want, `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`)

const root = mkdtempSync(join(tmpdir(), 'shelf-selftest-'))

// ---- 假的图片字节：extOf 只看文件头，所以给个头 + 填充就够 ----
const png = (n = 1) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(400, n)])
const gif = (n = 1) => Buffer.concat([Buffer.from('GIF89a', 'latin1'), Buffer.alloc(400, n)])
const jpg = (n = 1) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(400, n)])
const junk = () => Buffer.alloc(400, 7) // 认不出来的格式

const files = {
  'a.png': png(1),
  'b.gif': gif(2),
  'c.jpg': jpg(3),
  'd.jpg': jpg(4),
  'junk.bin': junk(),
  'tiny.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2]), // < minBytes
  'huge.png': Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(5 * 1024 * 1024)]),
}
const download = async (seg) => files[seg.data.file] ?? null
const seg = (file, extra = {}) => ({ type: 'image', data: { file, sub_type: '1', ...extra } })

// ---- 假的视觉模型：一篇篇按顺序喂答案 ----
const A_CAT = '看：一只橘猫趴在键盘上\n用：别人发疯时表示围观\n词：猫, 围观, 无语\n脏：无\n烂：无'
const A_DOG = '看：一只狗在摇头，配有"无语"两字\n用：表示无语\n词：狗, 无语\n脏：无\n烂：无'
const A_BLOCK = 'BLOCK'
const A_LOWQ = '看：一个圆胖的黄色 3D 小人捂着肚子\n用：不知道\n词：怪图, 黄色\n脏：无\n烂：有'

let answers = []
let describeCalls = 0
const describe = async (_file, prompt) => {
  describeCalls++
  ok('提示词里带两条安全线', /脏：/.test(prompt) && /烂：/.test(prompt))
  return answers[describeCalls - 1] ?? A_CAT
}

let made = 0
/** 每一块用**独立目录**：不然上一块收的图会留在库里，把后面的断言带歪。 */
function makeShelf(over = {}) {
  return createShelf({ dir: join(root, 'shelf-' + ++made), describe, log: () => {}, ...over })
}
function reset(seq = []) {
  answers = seq
  describeCalls = 0
}

// ============ 1. 收图 ============
{
  const shelf = makeShelf()
  const r = await shelf.harvest([seg('a.png'), seg('b.gif')], { nick: '阿猫', uid: '10001' }, download)
  eq('收到两张', r.added, 2)
  eq('库里 2 张', shelf.stats().total, 2)
  eq('都还没打标', shelf.stats().untagged, 2)
  ok('文件落盘了', existsSync(join(shelf.dir, shelf.get(1).file)))

  const r2 = await shelf.harvest([seg('a.png')], { nick: '阿猫' }, download)
  eq('同一张再来：不新增', r2.added, 0)
  eq('同一张再来：算「又见到」', r2.seen, 1)
  eq('库里还是 2 张', shelf.stats().total, 2)
  eq('seenCount 变成 2', shelf.get(1).seenCount, 2)

  await shelf.harvest([seg('tiny.png'), seg('huge.png'), seg('junk.bin')], { nick: '阿猫' }, download)
  eq('太小 / 太大 / 认不出的格式一律不收', shelf.stats().total, 2)

  // 这条是防"群友的真人照片被收进来"的那道闸
  await shelf.harvest([{ type: 'image', data: { file: 'a.png' } }], { nick: '阿猫' }, download)
  eq('没标 sub_type 的普通图片不收', shelf.stats().total, 2)

  eq('sub_type=1 算贴图', shelf.isSticker(seg('a.png')), true)
  eq('商城表情算贴图', shelf.isSticker({ data: { emoji_id: 'x' } }), true)
  eq('普通图片不算贴图', shelf.isSticker({ data: { file: 'x.jpg' } }), false)
}

// ============ 2. 打标（五行 → 字段） ============
{
  reset([A_CAT, A_DOG])
  const shelf = makeShelf()
  await shelf.harvest([seg('a.png'), seg('b.gif')], { nick: '阿猫' }, download)
  const n = await shelf.tagPending(10)
  eq('打了两张', n, 2)
  eq('模型被调两次', describeCalls, 2)
  const a = shelf.get(1)
  eq('画面描述', a.desc, '一只橘猫趴在键盘上')
  eq('场合', a.use, '别人发疯时表示围观')
  eq('关键词拆成数组', JSON.stringify(a.tags), JSON.stringify(['猫', '围观', '无语']))
  eq('不是成人图', !!a.adult, false)
  eq('不是烂梗', !!a.lowq, false)
  eq('打了哪版标', a.tagVer, TAG_VER)
  ok('清单里能看到它', shelf.catalog().includes('猫/围观/无语'))
  ok('清单是给模型读的一行一张', shelf.catalog().split('\n').length === 2)
  eq('重入有锁：跑第二次不动', await shelf.tagPending(10), 0)
}

// ============ 3. 挑图 ============
{
  reset([A_CAT, A_DOG])
  const shelf = makeShelf()
  await shelf.harvest([seg('a.png'), seg('b.gif')], { nick: '阿猫' }, download)
  await shelf.tagPending(10)

  const byTag = shelf.resolve('猫')
  ok('关键词能挑到', byTag && byTag.id === 1)
  ok('挑到的是真路径', byTag && existsSync(byTag.path))
  eq('挑了之后 uses+1', shelf.get(1).uses, 1)

  const byText = shelf.resolve('围观')
  ok('按含义（desc/use）也能挑到', byText && byText.id === 1)

  const byId = shelf.resolve('#2')
  ok('点名编号能挑到', byId && byId.id === 2)

  eq('关键词完全对不上 → 不硬凑', shelf.resolve('量子力学'), null)
  eq('点名不存在的编号 → 返回空', shelf.resolve('#99'), null)
  ok('空标签 = 随机一张', !!shelf.resolve(''))
}

// ============ 4. 两条安全线：BLOCK / 烂梗 / 成人图 ============
{
  reset([A_CAT, A_BLOCK, A_LOWQ])
  const shelf = makeShelf()
  await shelf.harvest([seg('a.png'), seg('b.gif'), seg('c.jpg')], { nick: '阿猫' }, download)
  await shelf.tagPending(10)

  eq('判 BLOCK 的直接拦下', shelf.get(2).blocked, true)
  eq('判烂梗的也拦下', shelf.get(3).blocked, true)
  eq('烂梗有标记', shelf.get(3).lowq, true)
  eq('三张里只剩一张能发', shelf.stats().usable, 1)
  ok('烂梗不进清单', !shelf.catalog().includes('#3'))

  // 成人图：连点名也不给（她不懂那是什么意思，顺手发出去是拿主人的脸冒险）
  const one = shelf.get(1)
  one.adult = true
  ok('成人图不进清单', !shelf.catalog().includes('#1'))
  eq('点名成人图 → 不发', shelf.resolve('#1'), null)
  eq('成人图不算可发', shelf.stats().usable, 0)
}

// ============ 5. 删：文件真删 + 哈希进黑名单 ============
{
  reset([A_CAT, A_DOG])
  const shelf = makeShelf()
  await shelf.harvest([seg('a.png'), seg('b.gif')], { nick: '阿猫' }, download)
  await shelf.tagPending(10)
  const hash = shelf.get(1).hash
  const p = join(shelf.dir, shelf.get(1).file)

  const r = shelf.remove(1, '不好看')
  eq('删成功', r.ok, true)
  eq('返回被删那个的哈希', r.hash, hash)
  ok('文件是真删的（不是挪进回收站）', !existsSync(p))
  eq('库里只剩 1 张', shelf.stats().total, 1)
  eq('删不存在的编号 → ok:false', shelf.remove(999).ok, false)

  // 关键：删过的图再被人发一次，不能原样收回来（去重看的是内容哈希，光删索引没用）
  const back = await shelf.harvest([seg('a.png')], { nick: '阿猫' }, download)
  eq('删过的收不回来', back.added, 0)
  eq('库里还是 1 张', shelf.stats().total, 1)
  ok('哈希进了黑名单', shelf.isBlockedHash(hash))
}

// ============ 6. 重排编号 ============
{
  reset([A_CAT, A_DOG, A_CAT])
  const shelf = makeShelf()
  await shelf.harvest([seg('a.png'), seg('b.gif'), seg('d.jpg')], { nick: '阿猫' }, download)
  await shelf.tagPending(10)
  shelf.remove(2, '测试')
  const r = shelf.renumber()
  eq('重排后剩 2 张', r.count, 2)
  const items = shelf._load().items
  eq('编号连续 1..2', JSON.stringify(items.map((i) => i.id).sort((x, y) => x - y)), JSON.stringify([1, 2]))
  ok(
    '文件名跟着编号改了',
    items.every((i) => i.file.startsWith(String(i.id) + '-')),
  )
  eq('nextId 跟着走', shelf._load().nextId, 3)
}

// ============ 7. index.json 真的读得回来 ============
{
  reset([A_CAT])
  const shelf = makeShelf()
  await shelf.harvest([seg('a.png')], { nick: '阿猫' }, download)
  await shelf.tagPending(10)
  const fresh = createShelf({ dir: shelf.dir, describe, log: () => {} }) // 新实例，从磁盘读
  eq('新实例读得到', fresh.stats().total, 1)
  ok('打过标的状态也留住了', fresh.get(1).desc === '一只橘猫趴在键盘上')
  const raw = JSON.parse(readFileSync(join(shelf.dir, 'index.json'), 'utf8'))
  ok('index.json 结构正常', Array.isArray(raw.items) && typeof raw.nextId === 'number')
}

// ============ 8. 协议无关的入库口 saveFiles（没有 IM 的场合用这条） ============
{
  reset([A_CAT, A_DOG])
  const shelf = makeShelf()
  // ① 直接给文件路径（先写两个真文件到临时目录）
  const dirA = join(root, 'ingest')
  mkdirSync(dirA, { recursive: true })
  const fa = join(dirA, 'one.png')
  const fb = join(dirA, 'two.gif')
  writeFileSync(fa, files['a.png'])
  writeFileSync(fb, files['b.gif'])
  const r1 = shelf.saveFiles([fa, fb], { nick: '手工倒' })
  eq('路径入库：收下 2 张', r1.added, 2)
  eq('路径入库：没跳过的', r1.skipped, 0)
  eq('来源记下来了', shelf.get(1).fromNick, '手工倒')

  // ② 同一份字节再来一次 → 认出来（seen），不重复收
  const r2 = shelf.saveFiles([fa])
  eq('同样的图再喂一次 → seen', r2.seen, 1)
  eq('库没变大', shelf.stats().total, 2)

  // ③ Buffer 直接给
  const r3 = shelf.saveFiles([{ buf: files['c.jpg'], summary: '手工塞的' }])
  eq('Buffer 入库', r3.added, 1)
  eq('summary 留着', shelf.get(3).summary, '手工塞的')

  // ④ 垃圾字节 / 太小 / 认不出格式 → 跳过，且不能把整批带倒
  const r4 = shelf.saveFiles([
    { buf: files['tiny.png'] },
    { buf: files['junk.bin'] },
    { buf: files['d.jpg'] },
  ])
  eq('垃圾跳过、好的照样收', r4.added, 1)
  eq('跳过 2 个', r4.skipped, 2)

  // ⑤ 删过的哈希不许从这条路回来
  shelf.remove(4, '测试：删了就真删')
  const r5 = shelf.saveFiles([{ buf: files['d.jpg'] }])
  eq('黑名单挡住了再收', r5.added, 0)
  eq('黑名单：记成跳过', r5.skipped, 1)

  // ⑥ 入库之后照样能打标、能挑
  await shelf.tagPending(10)
  eq('新入库的都打上标了（untagged 归零）', shelf.stats().untagged, 0)
  ok('也能被挑出来', !!shelf.resolve('猫'))
}

rmSync(root, { recursive: true, force: true })

if (fails.length) {
  console.log(`❌ ${fails.length} 项没过（过 ${pass} 项）：`)
  for (const f of fails) console.log('  · ' + f)
  process.exit(1)
}
console.log(`✅ 全过：${pass} 项`)
