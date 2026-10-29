# opencode-skill-vault

在 [OpenCode](https://opencode.ai) v2 里，把不常用的 skill 从常驻上下文里挪出去，
用到时再递一张名片。

**一句话：冷门 skill 不再每轮占 token，但需要时还能被发现。**

---

## 问题

opencode 会把 `~/.config/opencode/skills/` 下每个 skill 的 `name` + `description`
放进每轮对话的上下文。

```
10 个 skill  ≈ 1000 tokens     每轮
50 个 skill  ≈ 6000 tokens     每轮
```

绝大多数 skill 一年用不到三次，但每轮都在花钱。

---

## 做法

把冷门 skill 搬到 opencode **扫不到**的目录，插件在每条消息前扫一遍，
命中关键词就在消息末尾追加一段**候选清单**：

```xml
<skill_hint>
以下技能可能与本条消息相关，仅供你判断，不需要就忽略：
- xiaoyuzhou-search（命中「小宇宙」）— Search and extract podcast episode data...
  /home/you/.config/opencode/skill-vault/xiaoyuzhou-search/SKILL.md
需要时用 read 工具读取上面列出的 SKILL.md；不合适请直接忽略，不要强行使用。
</skill_hint>
```

**只报名字和一句用途，不塞正文。** 模型保有否决权：可以 `read` 它，也可以无视。

一段提示约 60~80 tokens，只在相关时出现；库里放 5 个还是 500 个，
常驻开销都是 0。

### 为什么不是「自动注入全文」

试过，不好。命中就灌全文等于替你拍板——用户随口提到「浏览器」，
可能只是聊天，不该把 8000 tokens 的操作手册塞进去。

实测过：用户说「去 obsidian 查香蕉」，模型看到 `obsidian-cli` 的提示后，
判断直接用 MCP 检索更快，忽略了它。**这是设计意图，不是失败。**

---

## 安装

### 1. 放插件

```bash
mkdir -p ~/.config/opencode/plugins
cp skill-vault.ts ~/.config/opencode/plugins/
```

重启 opencode。

### 2. 建库并搬 skill

```bash
mkdir -p ~/.config/opencode/skill-vault
mv ~/.config/opencode/skills/<不常用的那个> ~/.config/opencode/skill-vault/
```

**是移动，不是复制。** 留在 `skills/` 里的会继续每轮占上下文。

库里的结构是平的：一个子目录一个 skill，每层都要有 `SKILL.md`。

### 3. 写 keywords

在每个 `SKILL.md` 的 frontmatter 里加一行：

```yaml
---
name: obsidian-cli
description: Interact with Obsidian vaults using the Obsidian CLI...
keywords: [obsidian, 新建笔记, 搜笔记, 反向链接, 待办清单]
---
```

写**用户会说的话**，不是术语：

```
好：控制我的电脑 / 网页正文 / 文章太长
坏：CDP 协议 / DOM 解析 / tokenization
```

`name` 会自动参与匹配，不用在 keywords 里重复写。

### 4. 装斜杠命令（可选）

```bash
mkdir -p ~/.config/opencode/commands
cp vault-keywords.md ~/.config/opencode/commands/
```

之后在 TUI 里输入 `/vault-keywords`，它会扫描库，只给**新入库或正文变动过**的
skill 生成 keywords，没变的一律不碰。

---

## 配置（可选）

`~/.config/opencode/skill-vault.json`

```json
{
  "dirs": ["~/.config/opencode/skill-vault", "~/notes/agent-skills"]
}
```

默认就是 `~/.config/opencode/skill-vault`。支持多个目录，也支持 `~`。
目录不存在时会被跳过。

---

## 匹配规则

两级，在 `match()` 里：

| 级别 | 条件 | 例子 |
|---|---|---|
| strong | 消息里出现完整关键词 | 说「用 playwright-cli」→ 命中 `playwright-cli` |
| weak | 长关键词被短词部分命中 | 说「canvas」→ 命中 `json-canvas` |

排序时 strong 永远压过 weak。否则你说 `playwright-cli`，
会被它的兄弟 `playwright-remote-control` 抢走。

限制：

- 含空格的关键词（`obsidian 格式`）不做拆词反查，极易误命中
- 每条消息最多列 5 个候选
- 每会话每个技能只提示一次
- 消息里含 `skill-vault:ignore` 时整条跳过（给斜杠命令用，见下）

---

## 斜杠命令会自我污染

命令模板里常会列出技能名，插件会误判成「要用这些技能」。
所以命令正文开头必须带标记：

```markdown
<!-- skill-vault:ignore -->
```

插件见到就整条跳过。

---

## 调试

```bash
SKILL_VAULT_DEBUG=1 opencode
tail -f /tmp/skill-vault.log
```

日志：

```
indexed 4 skills from /home/you/.config/opencode/skill-vault
hinted xiaoyuzhou-search for ses_e79...
```

---

## 排错

| 现象 | 检查 |
|---|---|
| 库里技能从不触发 | 日志有没有 `indexed N skills`；`indexed 0` 说明路径不对，或文件名不是全大写 `SKILL.md` |
| 提示了但模型没用 | 正常，它判断不需要 |
| 张冠李戴 | 某个关键词太泛（`命令行`、`属性`），删掉 |
| 插件没加载 | `opencode run "hi" --print-logs --log-level debug`，找 `failed to load plugin` |

v2 的插件必须 `export default { id, setup }`。
只写 `export const X = async (ctx) => ({...})` 会报：

```
Plugin must export a default definition with an id and an effect or setup function
```

---

## 已知边界

**关键词是字面匹配。** 说「黄色的图」，库里写 `yellow`，匹配不上——除非两个都写。

**跨语言靠 keywords 硬扛。** description 写英文、用户说中文时，
向量检索也救不了多少（实测 top1 只有 3/12 提升到 8/12），
真正的杠杆是把中文关键词写全。

**不是每次都能发现。** 换一百种说法，总会有漏的。

**升级可能弄坏它。** 插件绑在 v2 的 `session.hook("prompt")` 上。
v1 → v2 换过一次插件接口，社区里同类项目就是这么失效的。

**没有依赖。** 只用 node 内置模块，不装 npm 包、不跑外部进程、不联网。

---

## 什么时候不该用

- **库少于 10 个 skill**：每轮省不到 1000 token，不值得多一层
- **天天用的 skill**：留在 `skills/` 里，要原生自动触发
- **想要「一定会被调用」**：这套是提示，不是强制

---

## 数据结构

`vault-keywords.md` 用一份指纹清单做增量检测：

```
~/.config/opencode/skill-vault.manifest.json
```

```
指纹 = sha256(SKILL.md 剔除 keywords 行 + 所有附属文件的路径和内容)
```

**必须剔除 keywords**，否则「改关键词 → 指纹变 → 下次又判定变动」会无限循环。

---

## License

MIT
