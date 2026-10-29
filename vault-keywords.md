---
description: 给 skill-vault 里新入库或已变动的技能生成 keywords（跳过没变动的）
---

<!-- skill-vault:ignore -->

你的任务：只给**需要更新**的技能生成 `keywords:` 字段，没变的一律不要碰。

## 一、变更检测（已由脚本算好）

!`python3 - <<'PY'
import os, re, json, hashlib

root = os.path.expanduser("~/.config/opencode/skill-vault")
state_path = os.path.expanduser("~/.config/opencode/skill-vault.manifest.json")

if not os.path.isdir(root):
    print("(库不存在，无事可做)")
    raise SystemExit

state = {}
if os.path.isfile(state_path):
    try:
        state = json.load(open(state_path, encoding="utf8"))
    except Exception:
        state = {}

todo, ok = [], []
for name in sorted(os.listdir(root)):
    d = os.path.join(root, name)
    p = os.path.join(d, "SKILL.md")
    if not os.path.isfile(p):
        continue

    # 指纹 = SKILL.md 正文（剔除 keywords 行）+ 所有附属文件的相对路径与内容
    # 必须剔除 keywords：否则改关键词 -> 指纹变 -> 下次又判定变动，无限循环
    h = hashlib.sha256()
    _raw = open(p, "rb").read()
    _txt = _raw.decode("utf8", "replace")
    _txt = re.sub(r"^keywords:.*$", "", _txt, flags=re.M)
    h.update(_txt.encode())
    for dirpath, dirnames, filenames in os.walk(d):
        dirnames[:] = sorted(x for x in dirnames if not x.startswith("."))
        for f in sorted(filenames):
            if f == "SKILL.md" or f.startswith("."):
                continue
            fp = os.path.join(dirpath, f)
            rel = os.path.relpath(fp, d)
            h.update(rel.encode())
            try:
                h.update(open(fp, "rb").read())
            except Exception:
                pass
    digest = h.hexdigest()[:16]

    t = open(p, encoding="utf8").read()
    m = re.match(r"^---\n(.*?)\n---", t, re.S)
    fm = m.group(1) if m else ""
    kw = re.search(r"^keywords:\s*(.*)$", fm, re.M)
    dm = re.search(r"^description:\s*(.*)$", fm, re.M)
    desc = dm.group(1).strip() if dm else ""
    kws = kw.group(1).strip() if kw else ""

    prev = state.get(name)
    reason = None
    if not kws:
        reason = "缺 keywords"
    elif prev is None:
        reason = "新入库（无记录）"
    elif prev.get("hash") != digest:
        reason = "正文变动"

    if reason:
        todo.append((name, reason, desc[:260], kws))
    else:
        ok.append(name)

print(f"需要处理 {len(todo)} 个，跳过 {len(ok)} 个")
print()
if todo:
    print("### 待处理")
    for name, reason, desc, kws in todo:
        print(f"- {name}  【{reason}】")
        print(f"  description: {desc}")
        print(f"  keywords: {kws or '（缺失）'}")
else:
    print("### 待处理：无")
if ok:
    print()
    print("### 跳过（未变动）")
    print("  " + ", ".join(ok))
PY`

## 二、如果"待处理"为空

直接回一句「库内无变动，跳过」，**不要读任何文件，不要改任何东西**，然后结束。

## 三、生成规则（只对"待处理"里的技能）

对每个技能生成 6~10 个关键词：

1. **写用户会说的话，不是术语。**
   好：`控制我的电脑`、`网页正文`、`文章太长`
   坏：`CDP 协议`、`DOM 解析`、`tokenization`

2. **中文为主。** 英文只保留工具名、产品名（`playwright`、`obsidian`、`WebP`）。

3. **覆盖不同说法。** 同一件事的动词变体：
   `提取正文` / `扒网页` / `网页转文本`
   不要写三个近义词凑数。

4. **不要写错拼变体。** 错拼可能有无限多种，穷举不完，占名额还没用——
   模型自己一般能纠正常见拼写错误。

5. **不要平泛词。** `工具`、`处理`、`帮忙`、`内容` 会命中一切。也禁止单字（`图`、`文`）。

6. **产品名/命令名必须收录，且要看正文。**
   用 `grep -oE "[A-Za-z][A-Za-z0-9_.-]{2,}" <目录>/SKILL.md | sort | uniq -c | sort -rn | head -30`
   扫出正文里高频的外部工具名、产品名，挑真的会被人点名的写进去。

7. **`name` 会自动参与匹配，不用重复写。** 别把目录名再塞一遍。

8. **领域本身要收录。** 用户说「教我学英语」，如果只写了「语法」「时态」就接不住。
   问自己：一个人想找这个技能，最可能先说出哪个大类词？
   `英语`、`笔记`、`浏览器`、`PDF` 这类上位词必须有。
   上位词不算"平泛词"——`工具` 命中一切，但 `英语` 只指向这个领域。

## 四、写入

只改"待处理"里的文件，把 `keywords: [...]` 写到 frontmatter 最后一行。
已有就**替换**，没有就**新增**。格式必须是单行 YAML 数组：

```yaml
keywords: [关键词1, 关键词2, 关键词3]
```

## 五、更新指纹记录

**只有真的改了文件才做这一步。** 待处理为空时跳过，不要执行。

改完后用 `shell` 工具跑下面这段（**不要**写成命令注入语法，否则每次运行都会无条件执行，
会在模型失败时提前登记指纹，导致那些技能永远不再重试）：

```bash
python3 - <<'PYEOF'
import os, re, json, hashlib

root = os.path.expanduser("~/.config/opencode/skill-vault")
state_path = os.path.expanduser("~/.config/opencode/skill-vault.manifest.json")

out = {}
for name in sorted(os.listdir(root)):
    d = os.path.join(root, name)
    p = os.path.join(d, "SKILL.md")
    if not os.path.isfile(p):
        continue
    h = hashlib.sha256()
    _txt = open(p, "rb").read().decode("utf8", "replace")
    _txt = re.sub(r"^keywords:.*$", "", _txt, flags=re.M)
    h.update(_txt.encode())
    for dirpath, dirnames, filenames in os.walk(d):
        dirnames[:] = sorted(x for x in dirnames if not x.startswith("."))
        for f in sorted(filenames):
            if f == "SKILL.md" or f.startswith("."):
                continue
            fp = os.path.join(dirpath, f)
            h.update(os.path.relpath(fp, d).encode())
            try:
                h.update(open(fp, "rb").read())
            except Exception:
                pass
    out[name] = {"hash": h.hexdigest()[:16]}

json.dump(out, open(state_path, "w", encoding="utf8"), indent=1, ensure_ascii=False)
print(f"已记录 {len(out)} 个技能的指纹")
PYEOF
```

## 六、汇报

一张表：技能名 / 处理原因 / 关键词数量 / 中文占比 / 最容易漏的说法。
跳过的技能不用逐个列，报个数字就行。
