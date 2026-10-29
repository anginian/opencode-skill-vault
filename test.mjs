/**
 * skill-vault 的纯函数测试。
 *
 * 不依赖 opencode，不需要启动服务。跑法：
 *   node --test test.mjs
 * 或
 *   bun test
 *
 * 只测不碰文件系统的逻辑：frontmatter 解析、两级匹配、排序、去重规则。
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { parseFrontmatter, match, hitKind, collect, coverage } from "./skill-vault.ts"

/* ---------------------------------------------------------- frontmatter */

test("parseFrontmatter: 单行数组", () => {
  const fm = parseFrontmatter(
    "---\nname: a\ndescription: hello\nkeywords: [x, y, z]\n---\n\nbody",
  )
  assert.equal(fm.name, "a")
  assert.deepEqual(fm.keywords, ["x", "y", "z"])
})

test("parseFrontmatter: 折行标量（>）", () => {
  const fm = parseFrontmatter(
    "---\nname: a\ndescription: >-\n  line one\n  line two\nkeywords: [k]\n---\n\nbody",
  )
  assert.equal(fm.name, "a")
  // 折行内容应被收集成描述，不被当成嵌套 key
  assert.ok(String(fm.description ?? "").includes("line one"))
  assert.deepEqual(fm.keywords, ["k"])
})

test("parseFrontmatter: 块状列表", () => {
  const fm = parseFrontmatter(
    "---\nname: a\ndescription: d\nkeywords:\n  - 小宇宙\n  - 播客\n---\n",
  )
  assert.deepEqual(fm.keywords, ["小宇宙", "播客"])
})

test("parseFrontmatter: 没有 frontmatter", () => {
  assert.deepEqual(parseFrontmatter("# just markdown"), {})
})

/* -------------------------------------------------------------- matching */

const skills = [
  { name: "playwright-cli", path: "/v/playwright-cli/SKILL.md", keywords: ["playwright-cli", "打开网页", "填表"] },
  { name: "playwright-remote-control", path: "/v/prc/SKILL.md", keywords: ["playwright-remote-control", "控制我的电脑", "局域网"] },
  { name: "json-canvas", path: "/v/json-canvas/SKILL.md", keywords: ["json-canvas", "思维导图", "画布"] },
  { name: "obsidian-markdown", path: "/v/om/SKILL.md", keywords: ["obsidian-markdown", "obsidian 格式", "双链"] },
  { name: "obsidian-cli", path: "/v/oc/SKILL.md", keywords: ["obsidian-cli", "搜笔记"] },
]

test("match: 完全命中关键词", () => {
  const r = match(skills, "帮我打开网页看看")
  assert.equal(r.length, 1)
  assert.equal(r[0].skill.name, "playwright-cli")
})

test("match: 名字直接命中（用户点名）", () => {
  const r = match(skills, "用 playwright-cli 打开页面")
  assert.equal(r[0].skill.name, "playwright-cli")
})

test("match: 点名 cli 不会带上 remote-control", () => {
  const r = match(skills, "用 playwright-cli 打开页面")
  const names = r.map((x) => x.skill.name)
  assert.equal(names[0], "playwright-cli")
  // "playwright" 是两个技能共享的族名，不该把兄弟技能拉进来
  assert.ok(!names.includes("playwright-remote-control"))
})

test("match: 拆词反查 —— 短词命中长关键词", () => {
  const r = match(skills, "创建一个 canvas 文件")
  assert.equal(r[0].skill.name, "json-canvas")
})

test("match: 族名不区分技能 —— 单独说 obsidian 谁也不命中", () => {
  // obsidian-cli / obsidian-markdown 共享 "obsidian"，它是类别词
  const r = match(skills, "帮我用 obsidian 查点东西")
  assert.equal(r.length, 0, "族名不该命中任何一个同族技能")
})

test("match: 无关消息返回空", () => {
  assert.equal(match(skills, "今天天气怎么样").length, 0)
})

test("match: 中文关键词是整串匹配，不做子串拆解", () => {
  // "控制我的电脑" 是完整短语；说 "电脑" 或 "操作" 都不该命中它
  assert.equal(match(skills, "电脑好慢").length, 0)
  assert.equal(match(skills, "帮我操作一下").length, 0)
  // 说完整短语才命中
  const r = match(skills, "帮我控制我的电脑")
  assert.equal(r[0].skill.name, "playwright-remote-control")
})

test("hitKind: strong=2 weak=1 miss=0", () => {
  const words = ["canvas"]
  assert.equal(hitKind("canvas", "canvas", words), 2)
  assert.equal(hitKind("json-canvas", "canvas", words), 1)
  assert.equal(hitKind("思維導圖", "canvas", words), 0)
})

/* ---------------------------------------------------------------- collect */

test("collect: 递归扫描，忽略隐藏目录", () => {
  const root = mkdtempSync(join(tmpdir(), "sv-test-"))
  try {
    mkdirSync(join(root, "a", "deep"), { recursive: true })
    mkdirSync(join(root, ".hidden"), { recursive: true })
    writeFileSync(
      join(root, "a", "deep", "SKILL.md"),
      "---\nname: deep-skill\ndescription: d\nkeywords: [甲, 乙]\n---\n",
    )
    writeFileSync(
      join(root, ".hidden", "SKILL.md"),
      "---\nname: hidden-skill\ndescription: d\nkeywords: [丙]\n---\n",
    )
    const got = collect({ dirs: [root] })
    const names = got.map((s) => s.name)
    assert.ok(names.includes("deep-skill"))
    assert.ok(!names.includes("hidden-skill"), "隐藏目录应被跳过")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("collect: name 自动进 keywords，且不重复", () => {
  const root = mkdtempSync(join(tmpdir(), "sv-test-"))
  try {
    mkdirSync(join(root, "x"), { recursive: true })
    writeFileSync(
      join(root, "x", "SKILL.md"),
      "---\nname: x-skill\ndescription: d\nkeywords: [x-skill, 甲]\n---\n",
    )
    const [s] = collect({ dirs: [root] })
    assert.equal(s.keywords.filter((k) => k === "x-skill").length, 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("collect: 没有 keywords 时从描述退化提词", () => {
  const root = mkdtempSync(join(tmpdir(), "sv-test-"))
  try {
    mkdirSync(join(root, "y"), { recursive: true })
    writeFileSync(
      join(root, "y", "SKILL.md"),
      "---\nname: y-skill\ndescription: compress images to webp\n---\n",
    )
    const [s] = collect({ dirs: [root] })
    assert.ok(s.keywords.length > 1)
    assert.ok(s.keywords.includes("y-skill"))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

/* ------------------------------------------------------------- coverage */

test("coverage: 命中越多分越高，但有上限", () => {
  assert.equal(coverage(0), 0)
  assert.ok(coverage(1) < coverage(2))
  assert.ok(coverage(2) < coverage(3))
  assert.ok(coverage(10) <= 1)
})

test("match: 多关键词命中排在单关键词命中之前", () => {
  const pool = [
    // A 只中一个强词
    { name: "podcast-tools", path: "/a", keywords: ["播客"] },
    // B 中三个强词
    { name: "xiaoyuzhou-search", path: "/b", keywords: ["小宇宙", "播客", "播放量"] },
  ]
  const r = match(pool, "小宇宙播客的播放量")
  assert.equal(r[0].skill.name, "xiaoyuzhou-search")
  assert.equal(r[0].strong, 3)
  assert.equal(r[1].strong, 1)
})

test("match: 覆盖率不推翻 strong > weak", () => {
  // weak 命中多个，仍不该压过 strong 命中一个
  const pool = [
    { name: "json-canvas", path: "/c", keywords: ["json-canvas"] },
    { name: "canvas-extra", path: "/d", keywords: ["canvas-extra"] },
  ]
  const r = match(pool, "json-canvas")
  assert.equal(r[0].skill.name, "json-canvas")
})

test("match: 分数可用于排序且稳定", () => {
  const r1 = match(skills, "用 playwright-cli 打开网页填表")
  const r2 = match(skills, "用 playwright-cli 打开网页填表")
  assert.deepEqual(r1.map(x => x.skill.name), r2.map(x => x.skill.name))
  assert.ok(r1[0].score > 0)
})
