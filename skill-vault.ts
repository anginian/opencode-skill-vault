/**
 * skill-vault — OpenCode 2 插件
 *
 * 目的：把不常用的 skill 从 `~/.config/opencode/skills/` 挪到一个 opencode
 * 不扫描的目录里，让它们不再每轮占上下文。靠两件事把它们找回来：
 *
 *   1. 关键词表（由各 SKILL.md 的 `keywords:` 字段自动汇总）出现在工具的
 *      description 里 —— 模型每轮都看得见，命中就知道有这么个东西。
 *   2. 用户消息命中关键词时，直接把那份 SKILL.md 全文注入本轮对话
 *      （v2 的 `session.hook("prompt")` 允许改写 prompt.text），
 *      模型不需要"自觉想起"。
 *
 * 两条路都走，谁先命中谁生效；注入过的不再重复注入。
 *
 * 配置（可选）：~/.config/opencode/skill-vault.json
 *   { "dirs": ["~/.config/opencode/skill-vault"] }
 */

import { existsSync, readFileSync, readdirSync, appendFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { isAbsolute, join, relative } from "node:path"

export const PLUGIN_ID = "skill-vault"
const DEFAULT_DIRS = [join(homedir(), ".config", "opencode", "skill-vault")]
const CONFIG_PATH = join(homedir(), ".config", "opencode", "skill-vault.json")
const LOG_PATH = join(tmpdir(), "skill-vault.log")

const debug = (msg) => {
  if (process.env.SKILL_VAULT_DEBUG !== "1") return
  try {
    appendFileSync(LOG_PATH, `${new Date().toISOString()} ${msg}\n`)
  } catch {}
}

/* ------------------------------------------------------------ frontmatter */

// 只认 v2 需要的几个字段，够用就行。故意不做完整 YAML。
export function parseFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  if (!m) return {}
  const out = {}
  const lines = m[1].split(/\r?\n/)
  let key = null
  let buf = []
  const flush = () => {
    if (key && buf.length) {
      if (out[key] === undefined) out[key] = []
      out[key].push(...buf)
    }
    buf = []
  }
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "")
    if (!line.trim()) continue
    const top = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line)
    if (top && !line.startsWith(" ") && !line.startsWith("\t")) {
      flush()
      key = top[1]
      const rest = top[2].trim()
      // 折行块 >、>-、|、|- 一律当空，靠后续缩进行兜
      if (/^[>|][+-]?$/.test(rest)) continue
      if (rest.startsWith("[") && rest.endsWith("]")) {
        out[key] = rest
          .slice(1, -1)
          .split(",")
          .map((s) => s.trim().replace(/^['"]|['"]$/g, ""))
          .filter(Boolean)
        continue
      }
      if (rest) out[key] = rest.replace(/^['"]|['"]$/g, "")
      continue
    }
    // 缩进行：列表项或折行标量的续行
    const item = /^\s+-\s+(.*)$/.exec(line)
    if (item) {
      buf.push(item[1].trim().replace(/^['"]|['"]$/g, ""))
      continue
    }
    if (line.startsWith(" ") || line.startsWith("\t")) {
      buf.push(line.trim().replace(/^['"]|['"]$/g, ""))
    }
  }
  flush()
  return out
}

/* ------------------------------------------------------------------ scan */

function expand(p) {
  if (p === "~") return homedir()
  if (p.startsWith("~/")) return join(homedir(), p.slice(2))
  return isAbsolute(p) ? p : join(homedir(), p)
}

function loadConfig() {
  let cfg = {}
  try {
    if (existsSync(CONFIG_PATH)) cfg = JSON.parse(readFileSync(CONFIG_PATH, "utf8"))
  } catch (e) {
    debug(`config parse failed: ${e?.message}`)
  }
  const dirs = (Array.isArray(cfg.dirs) && cfg.dirs.length ? cfg.dirs : DEFAULT_DIRS)
    .map(expand)
    .filter((d) => existsSync(d))
  return { dirs }
}

function walk(root, out, depth = 0) {
  if (depth > 6) return
  let entries = []
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    if (e.name.startsWith(".") || e.name === "node_modules") continue
    const full = join(root, e.name)
    if (e.isDirectory()) walk(full, out, depth + 1)
    else if (e.name === "SKILL.md") out.push(full)
  }
}

export function collect({ dirs }) {
  const files = []
  for (const d of dirs) walk(d, files)
  const skills = []
  for (const file of files) {
    let fm = {}
    try {
      fm = parseFrontmatter(readFileSync(file, "utf8"))
    } catch (e) {
      debug(`read failed ${file}: ${e?.message}`)
      continue
    }
    const name = String(fm.name || file.replaceAll("\\", "/").split("/").slice(-2, -1)[0] || "")
    if (!name) continue
    let keywords = fm.keywords
    if (typeof keywords === "string") keywords = [keywords]
    if (!Array.isArray(keywords) || !keywords.length) {
      // 没写 keywords 就退化用 name + description 里的词
      const desc = Array.isArray(fm.description) ? fm.description.join(" ") : String(fm.description || "")
      keywords = String(desc).split(/[^0-9A-Za-z\u4e00-\u9fff]+/)
        .filter((w) => w && w.length > 1)
        .slice(0, 6)
    }
    // skill 名字永远参与匹配：用户常常直接点名，"用 playwright-cli 打开页面"
    const pool = [name, ...keywords.map((k) => String(k).trim()).filter(Boolean)]
    const unique = [...new Set(pool)]
    const dir = dirs.find((d) => file.startsWith(d)) || ""
    // brief: description 的第一句，给"候选清单"用，尽量短
    const rawDesc = Array.isArray(fm.description) ? fm.description.join(" ") : String(fm.description || "")
    const firstSentence = rawDesc.replace(/\s+/g, " ").split(/(?<=[。！？.!?])\s/)[0] || rawDesc
    const brief = (firstSentence || name).slice(0, 90)
    skills.push({
      name,
      path: file,
      rel: dir ? relative(dir, file).replace(/\/SKILL\.md$/, "") : name,
      keywords: unique,
      brief,
    })
  }
  skills.sort((a, b) => a.name.localeCompare(b.name))
  return skills
}

/* ---------------------------------------------------------------- matching */

// 双向匹配：
//   用户说 "用 playwright-cli"  → 消息包含关键词      lower.includes(kw)   strong
//   用户说 "创建一个 canvas"    → 关键词包含消息里的词   kw.includes(word)    weak
// 两类分开计数：完全包含永远压过拆词命中，
// 否则 "playwright-cli" 会被 "playwright-remote-control" 抢走。
export function hitKind(keyword, lower, words, isName = false, familyWords = new Set()) {
  const k = keyword.toLowerCase().trim()
  if (!k) return 0
  if (lower.includes(k)) return 2 // strong
  // 含空格的关键词（如 "obsidian 格式"）不做拆词反查，极易误命中
  if (/\s/.test(k)) return 0
  // 名字参与拆词反查，但要排除"族名"：
  // obsidian-cli / obsidian-markdown 共享 "obsidian"，说明它是类别词不是区分词，
  // 用户说 "obsidian" 时不该命中其中任何一个。
  if (isName && familyWords.has(k)) return 0
  // 长关键词被用户的短词部分命中（"json-canvas" ← "canvas"）
  if (k.length >= 5 && words.some((w) => w.length >= 4 && w !== k && !(isName && familyWords.has(w)) && k.includes(w))) {
    return 1 // weak
  }
  return 0
}

// 找出被多个技能名字共享的词（含连字符拆开的片段），这些词没有区分度
export function findFamilyWords(skills) {
  const seen = new Map()
  for (const s of skills) {
    const parts = new Set(
      String(s.name)
        .toLowerCase()
        .split(/[^0-9a-z\u4e00-\u9fff]+/)
        .filter((p) => p.length >= 4),
    )
    for (const p of parts) seen.set(p, (seen.get(p) || 0) + 1)
  }
  return new Set([...seen.entries()].filter(([, n]) => n > 1).map(([w]) => w))
}

export function match(skills, text) {
  const lower = text.toLowerCase()
  const words = lower.split(/[^0-9a-z\u4e00-\u9fff]+/).filter((w) => w.length >= 2)
  const family = findFamilyWords(skills)
  const scored = []
  for (const s of skills) {
    let strong = 0
    let weak = 0
    const which = []
    for (const k of s.keywords) {
      const kind = hitKind(k, lower, words, k === s.name, family)
      if (!kind) continue
      if (kind === 2) strong++
      else weak++
      which.push(k)
    }
    if (strong + weak) scored.push({ skill: s, strong, weak, hits: strong + weak, which })
  }
  // 先按「完全包含」的个数降序，再按总数，最后按名字保证确定性
  scored.sort(
    (a, b) => b.strong - a.strong || b.hits - a.hits || a.skill.name.localeCompare(b.skill.name),
  )
  return scored
}

/* ------------------------------------------------------------------ setup */

async function setup(ctx) {
  const cfg = loadConfig()
  let skills = []
  // key = `${sessionID}:${path}`，每条消息后会按会话裁剪，防止无限增长
  const injected = new Map()
  const INJECTED_PER_SESSION = 50

  const markInjected = (sessionID, path) => {
    const key = `${sessionID}:${path}`
    injected.set(key, Date.now())
    // 只保留本会话的记录；会话结束后这些键再也没人查
    const prefix = `${sessionID}:`
    if (injected.size > INJECTED_PER_SESSION * 8) {
      for (const k of injected.keys()) {
        if (!k.startsWith(prefix)) injected.delete(k)
      }
    }
  }

  // 每次命中前重新扫一遍：库里的技能会被搬动、改名、新增，
  // 缓存路径会指向已经不存在的文件。
  const refresh = () => {
    skills = collect(cfg)
    debug(`indexed ${skills.length} skills from ${cfg.dirs.join(",")}`)
  }
  refresh()

  /* ---- 1. 关键词命中 → 只列出候选，由模型自己判断要不要用 ---- */
  if (ctx?.session?.hook) {
    await ctx.session.hook("prompt", async (event) => {
      try {
        const text = typeof event?.prompt?.text === "string" ? event.prompt.text : ""
        if (!text) return
        if (event?.metadata?.[PLUGIN_ID]) return // 我们自己加的提示不再处理
        // 斜杠命令展开的模板里会列出技能名，会被误判成"要用这些技能"。
        // 命令正文里带 <!-- skill-vault:ignore --> 标记的，整条跳过。
        if (text.includes("skill-vault:ignore")) return
        if (!cfg.dirs.length) return // 没配库，直接跳过，不扫盘
        const sessionID = event?.sessionID || "default"
        refresh() // 库可能被搬动/新增过，每次重新建索引
        const hits = match(skills, text)
        if (!hits.length) return

        // 每会话每个技能只提示一次，避免反复刷
        const fresh = hits.filter(({ skill }) => {
          const key = `${sessionID}:${skill.path}`
          if (injected.has(key)) return false
          markInjected(sessionID, skill.path)
          return true
        })
        if (!fresh.length) return

        const lines = fresh
          .slice(0, 5)
          .map(({ skill, which }) => {
            // 只取 description 的第一句，控制在 80 字符内
            const oneLine = String(skill.brief || "").replace(/\s+/g, " ").trim().slice(0, 80)
            return `- ${skill.name}（命中「${which.slice(0, 3).join("/")}」）— ${oneLine}\n  ${skill.path}`
          })
          .join("\n")

        event.prompt.text =
          text +
          `\n\n<skill_hint>\n` +
          `以下技能可能与本条消息相关，仅供你判断，不需要就忽略：\n` +
          `${lines}\n` +
          `需要时用 read 工具读取上面列出的 SKILL.md；不合适请直接忽略，不要强行使用。\n` +
          `</skill_hint>\n`
        debug(`hinted ${fresh.map((f) => f.skill.name).join(",")} for ${sessionID}`)
      } catch (e) {
        debug(`prompt hook error: ${e?.message}`)
      }
    })
  }

  debug("setup complete")
  return async () => {
    injected.clear()
  }
}

export default {
  id: PLUGIN_ID,
  setup,
}
