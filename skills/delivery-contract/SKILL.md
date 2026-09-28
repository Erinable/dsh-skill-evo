---
name: delivery-contract
description: "交付契约。接到指派的子 issue 就先读，开 PR、发交付或交接评论之前必须读过；回应评审（PASS / BLOCK）、需要成员拍板提问、发现 spec 有问题、建任何 issue（含「另建跟踪票」）之前查重时也用。"
---

执行 agent 在一张子 issue 上交付一个 PR 的完整契约：怎么交付、怎么被评审、怎么提问、怎么交接。Reviewer 按「评审契约」一节执行。

拍板人见 `docs/agents/instance.md` 的 `Decision maker`；该文件记录工作区实例事实。

本文用到的标识：

- `<KEY>`：本 issue 的编号，如 `SKIL-18`，取自 `multica issue get <issue> --output json` 的 `identifier`。

## 交付步骤

1. **分支**：只在本次 run 起始的任务分支（`agent/<agent>/<key>`）上提交并推送，由 `multica repo checkout` 或 worktree 给出。分支名里带着 issue key，PR 靠它自动关联 issue。
   完成判据：`git branch --show-current` 输出的仍是起始分支名。
2. **同步基点**：开工前 `git fetch origin`。任务分支落后于 `origin/main` 时，在任务分支上 `git merge origin/main`，不新建也不切换分支。
   完成判据：`git merge-base --is-ancestor origin/main HEAD` 退出码为 0，`git branch --show-current` 仍是起始分支名。
3. **推送**：`git push -u origin <任务分支>`。失败时重试，**最多 3 次**，可带 `-c http.lowSpeedLimit=1 -c http.lowSpeedTime=30` 防止挂住（`git -c http.lowSpeedLimit=1 -c http.lowSpeedTime=30 push -u origin <任务分支>`）。3 次都失败就停止重试，把 issue 置为 `blocked`，评论里贴出失败的命令和实际输出。
   完成判据：`git status -sb` 显示与 `origin/<任务分支>` 同步；或 issue 已为 `blocked` 且评论里有失败命令和输出。
4. **开 draft PR**：
   ```bash
   gh pr create --draft --base main --title "<KEY>: <一句话>" --body-file ./pr-body.md
   ```
   `pr-body.md` 第一行是 `Closes <KEY>`，正文最后一行是 `修改意见请评论在 <KEY> 上`（有 attribution 行时放在它之前）。代码、测试、配置以及 `skills/**` 下非 Markdown 文件的 PR 由成员合并；`docs/**`、`specs/**`、`skills/**` 下的 Markdown 文件和根目录 `CONTEXT.md` 按「被评审之后」由 Reviewer 合并。
   完成判据：`gh pr view --json isDraft,title,body` 显示 `isDraft: true`，标题以 `<KEY>: ` 开头，首行是 `Closes <KEY>`，attribution 之前的最后一行是 `修改意见请评论在 <KEY> 上`。
5. **状态**：先 `multica issue status <issue> in_review`，再发交接评论。顺序不能反：@Reviewer 会立刻起 Reviewer 的 run，状态还没改就可能被读到旧状态。只有不可逆、权限或花费问题无法推进时才改用「提问」一节并置 `blocked`。`done` 由合并 PR 自动完成。
   完成判据：`multica issue get <issue> --output json` 的 `status` 为 `in_review` 或 `blocked`。
6. **交接评论**：在自己的子 issue 上发一条评论，写 PR 链接、证据（实际命令和实际输出），**只用「交接」一节的交接命令发出**，`TO=Reviewer`。
   完成判据：交接命令最后打印 `handoff ok: Reviewer <评论 id>`。没打印就是没交接，issue 不能停在 `in_review` 就结束 run。

修改意见以 Multica issue 上的评论为准。GitHub 上的评论不会触发任何 agent，只能等每日巡检转到 issue 上，最迟隔一天，所以 PR 末尾那句提示仍是必需的。

## 被评审之后

- **PASS**：Reviewer 已把 PR 转为正式 PR。Reviewer 先运行 `gh api "repos/{owner}/{repo}/pulls/<n>/files?per_page=100" --paginate --jq '.[] | .filename, (.previous_filename // empty)'`，逐行确认每个当前路径和重命名前路径都匹配 `^(docs/|specs/|skills/).+\.md$` 或 `^CONTEXT\.md$`。全部路径命中时执行 `gh pr merge <n> --merge`，并在 issue 上说明已自动合并；任何代码、测试、配置或 `skills/**` 下非 Markdown 路径不匹配时，Reviewer 只在 issue 上写「等待成员合并」。
- **BLOCK**：Reviewer 在 issue 上写明哪条验收标准没过、在哪、改什么，并 @ 你。回到**原任务分支**返工、推送（同一个 PR 自动更新），再按交付步骤 5、6 先置 `in_review`、再发交接评论并 @Reviewer。
- **第 3 次 BLOCK**：Reviewer 会把 issue 置为 `blocked` 并写明需要成员决定什么。此时等成员回复，回复到来时按回复继续。
- **GitHub 意见**：issue 上出现以 `GitHub 意见：#<n>` 开头、@ 你的评论，是每日巡检把成员留在 GitHub PR 上的意见转了过来。把引用的每条意见当作成员在 issue 上的评论处理：要改就回原任务分支返工、推送，再按交付步骤 5、6 置 `in_review`、发交接评论并 @Reviewer，交接评论里逐条写每个意见链接怎么处理的；只是提问就在 issue 上回答，不改状态。不要去 GitHub 上回复。
- **PR 冲突**：每日巡检或成员在 issue 上 @ 你说 PR 与 main 冲突时，按「PR 冲突时」处理。PASS 之后也可能发生。

## 评审契约（Reviewer）

1. **只读检出**：`git fetch origin` 后执行 `git diff origin/main...origin/<分支>`，工作区保持无提交。
2. **PASS**：先 `gh pr view <n> --json mergeable,mergeStateStatus`，`mergeable` 为 `CONFLICTING` 时不判 PASS，改判 BLOCK，理由写「与 main 冲突，按『PR 冲突时』处理」（`UNKNOWN` 等 10 秒再查一次）。然后 `gh pr ready <n>` 把 draft 转为正式 PR，`gh pr comment <n> --body-file <file>` 贴结论。按「被评审之后」的机械白名单检查 `gh api "repos/{owner}/{repo}/pulls/<n>/files?per_page=100" --paginate --jq '.[] | .filename, (.previous_filename // empty)'`：逐行确认当前路径和重命名前路径都匹配 `^(docs/|specs/|skills/).+\.md$` 或 `^CONTEXT\.md$`；全部命中时由 Reviewer 执行 `gh pr merge <n> --merge`，并在子 issue 上评论「已由 Reviewer 合并」；任一路径未命中（包括代码、测试、配置或 `skills/**` 下非 Markdown 文件）时在子 issue 上评论「等待成员合并」。
3. **BLOCK**：在子 issue 上评论，写清哪条验收标准没过、在哪个位置、要改什么，用「交接」一节的交接命令发出，`TO=<原执行 agent 名>`、`PARENT=<触发你的交接评论 id>`。
4. **ADR 检查**：PR 引入的不可逆决策（数据格式、公开接口、依赖方向）有没有对应的 `docs/adr/` 文件；PR 与已有 ADR 冲突时，有没有按 `docs/agents/domain.md` 的「Flag ADR conflicts」显式标出；新 ADR 的编号是否与 `origin/main` 上已有的编号冲突，冲突时后合并的 PR 改号。任何一项没满足就判 BLOCK，理由写明缺的是哪一项。
5. **冲突复核**：执行 agent 解完冲突后 @ 你，交接评论第一行是 `冲突已解决：#<n>`。按「PR 冲突时」的复核规则只核对合并本身。
6. **轮次**：发 BLOCK 前先数这张 issue 上已有几条 BLOCK。本次是第 3 次时，改为把 issue 置为 `blocked`，评论里写明需要成员做什么决定，这一次不 @ 执行 agent。

为了让轮次可数（冲突复核的 BLOCK 也计入），每条评审评论的第一行固定写 `评审结论：PASS` 或 `评审结论：BLOCK`。

## PR 冲突时

PR 已交付（`in_review`，不管是 draft 待评审还是已 PASS 等合并）后 main 前进，PR 变成 `mergeable: CONFLICTING`。发现方是每日巡检（`orchestrate` 的 `PATROL.md`「PR 冲突查」）或成员，都会在子 issue 上评论并 @ 你。

1. **原分支**：回到原任务分支，不新建分支、不开新 PR、不 rebase、不 force push。`git fetch origin && git merge origin/main`。
2. **解冲突**：按 `resolving-merge-conflicts` 解。两边意图都保留；main 已经用别的方式实现了本票内容时，保留 main 的实现，把本 PR 收窄为仍然缺的部分，并在交接评论里写明收窄了什么。
3. **重跑测试**：跑本票涉及的每个包的 build 和 test，贴实际命令和实际输出。
   完成判据：`git merge-base --is-ancestor origin/main HEAD` 退出码 0；推送后 `gh pr view <n> --json mergeable` 为 `MERGEABLE`（`UNKNOWN` 等 10 秒再查）。
4. **推送**：按交付步骤 3 推送到原分支，同一个 PR 自动更新。PR 描述里写的范围变了（第 2 步收窄）就同步改描述。
5. **状态与交接**：状态保持或改回 `in_review`，再发交接评论并 @Reviewer（交付步骤 5、6）。评论第一行写 `冲突已解决：#<n>`，正文写合并提交、冲突文件、每处怎么取舍、测试输出。

**是否重新评审**：一律 @Reviewer，范围按下表。

| 冲突前状态 | 复核范围 | 结论 |
|---|---|---|
| draft，还没评审 | 正常评审（评审契约第 1–4 步） | PASS / BLOCK |
| 已 PASS | 只看合并本身：本 PR 相对 main 的净改动（`git diff origin/main...origin/<分支>`）与上次 PASS 时一致，冲突文件里 main 的改动没被丢掉 | 一致：`评审结论：PASS`，写「第 N 轮 PASS 保持」；PR 已是正式 PR，不用再 `gh pr ready` |
| 已 PASS，但第 2 步收窄或改动了实现 | 按净改动重新完整评审 | PASS / BLOCK |

完成判据：PR 为 `MERGEABLE`，子 issue 上有一条 `冲突已解决：#<n>` 交接评论 @Reviewer，之后有一条 Reviewer 的 `评审结论：` 评论。

## 提问（需要成员拍板时）

1. **一次问完**：一轮问题写在一条评论里，每个问题带编号并附默认答案。`business judgment` 直接记录 `采用默认答案，成员可推翻`，继续当前流程，不置 `blocked`；只有 `irreversible / permission / spending` 问题写出固定字段 `提问目标 user_id`、`提问类别`、`默认答案`、`提问时间` 和 `resume status: <todo|in_progress>`，置 `blocked` 并等待成员。
2. 目标规则仅适用于受保护问题：先读 issue 描述里的 `需求提出人 user_id`（子 issue 继承父 issue）；显式写 `unresolved` 时立即回退 Decision maker；没有记录时再用触发评论的 member 作者，再用 `creator_id`（仅 `creator_type == member`），最后回退 Decision maker。不可逆决策、权限或花费问 Decision maker。需求提出人就是 Decision maker 时只问这一人。一个问题只指定一个目标。
3. 仅对 `irreversible / permission / spending` 使用所选 tracker adapter 的 `Ask a person and wait` 一节，传入 `issue`、文件中的 `body`，以及触发线程 `thread` 和回复后的 `next`（如有）。由 adapter 负责发布、收件人解析、只过滤目标成员的一次性唤醒和结束本次 run；调用方不得复制 tracker 命令。其他成员的回复只作上下文，不算回答。
4. 目标成员无回复时按 `orchestrate/PATROL.md` 的固定标记升级表处理。每个提醒、转交、超时标记都带原提问评论 id：2 天提醒一次；4 天停旧目标 wakeup、转 Decision maker（负责人不是原提问 agent 时按 adapter 注册替代 wakeup），原目标迟到回复只作上下文；7 天停掉仍挂着的 wakeup，将 issue 置 `backlog` 并通知 Decision maker。业务判断不进入等待状态。巡检覆盖有待回答提问的父 issue、子 issue 和无父 issue 的票。

完成判据：业务判断已发布默认决议并继续；不可逆、权限或花费问题评论已发出、包含目标/类别/默认值/时间戳，issue 为 `blocked`，并已按 adapter 规则结束本次 run。

## 交接：必须显式 @

显式 @ 是唯一已证实会给对方起 run 的交接方式（SKIL-18/21/26 的每一次交接都靠它）。不带 @ 的 agent 评论能不能唤醒 issue 负责人，没有验证过，不要依赖。mention 会给对方起一个新 run，只在真的交出工作时用；致谢和告知写纯文本。

**交接评论只用下面这条命令发，不手写 mention、不手抄 id、不直接 `multica issue comment add`。** 先把正文（不含 mention）写进 `./handoff.md`，改第一行的三个值，整段粘进一次 shell 调用：

```bash
ISSUE=<issue id>; BODY=./handoff.md; TO=Reviewer; PARENT=
(
  set -eu
  [ -s "$BODY" ] || { echo "handoff FAILED: $BODY missing or empty" >&2; exit 1; }
  perl -pi -e 's#\[@?([^\]]*)\]\(mention://(agent|squad)/[^)]*\)#\@$1#g; s#mention://(agent|squad)/#mention:‹$1›/#g' "$BODY"
  ID=$(multica agent list --output json | jq -r --arg n "$TO" '[.[] | select(.name == $n) | .id] | if length == 1 then .[0] else empty end')
  [ -n "$ID" ] || { echo "handoff FAILED: no unique agent named $TO" >&2; exit 1; }
  if [ "$TO" = Reviewer ]; then
    ST=$(multica issue get "$ISSUE" --output json | jq -r .status)
    [ "$ST" = in_review ] || { echo "handoff FAILED: status is $ST, set in_review first" >&2; exit 1; }
  fi
  printf '\n[@%s](mention://agent/%s)\n' "$TO" "$ID" >> "$BODY"
  N=$(grep -cE 'mention://(agent|squad)/' "$BODY" || true)
  [ "$N" = 1 ] || { echo "handoff FAILED: $N mention lines, want 1" >&2; exit 1; }
  CID=$(multica issue comment add "$ISSUE" --content-file "$BODY" ${PARENT:+--parent "$PARENT"} --output json | jq -r .id)
  multica issue comment list "$ISSUE" --compact --output json \
    | jq -e --arg c "$CID" --arg m "mention://agent/$ID" '.[] | select(.id == $c) | .content | contains($m)' >/dev/null \
    || { echo "handoff FAILED: posted comment $CID does not carry the mention" >&2; exit 1; }
  rm -f "$BODY"
  echo "handoff ok: $TO $CID"
)
```

- `TO`：交给谁，填 agent 的 `name`。交付和返工是 `Reviewer`；Reviewer 打回是原执行 agent（如 `Builder`）；spec 有问题是 `Mika`。只有 `TO=Reviewer` 时检查状态已是 `in_review`（交付步骤 5）。
- `PARENT`：本次 run 是被某条评论触发的（比如 Reviewer 的 BLOCK），填那条评论的 id；否则留空。
- 命令先清理正文里所有 agent / squad mention（见下一节），再按名字现查 id 追加唯一一行交接 mention，数到恰好 1 行才发，发完读回这条评论确认 mention 还在。
- 输出 `handoff ok: <TO> <评论 id>` 才算交接完成。输出 `handoff FAILED: ...` 时按提示修正后重跑整段，不要改用手写评论绕过。

这条命令防的是已发生过的四种漏交接：没读本 skill 就按 agent 通用规则发了不带 @ 的评论（SKIL-55/61/62/66/67）；手写 mention 时写错对象（SKIL-63 @ 了 Sleuth）；手抄 id 抄错一位，grep 照样数到 1（SKIL-82 的 `acc6459c`）；返工回复里没带 @（SKIL-67）。

## 贴原始输出前清理 mention

任何贴进 issue 评论、PR 描述、PR 评论的原始输出——`multica` 命令的 JSON（`issue runs` 的 `trigger_summary`、`issue get`、`comment list` 都可能带）、别的评论的正文、日志——发出前都要去掉 agent 和 squad 的 mention 链接。**代码块里的也要去掉**：代码块不会让 mention 失效，照样起 run（SKIL-27：一条评论贴了 `issue runs` 的原始 JSON，里面的 agent mention 多起了一个 run）。`mention://issue/`、`mention://member/` 不起 run，可以保留。

写好正文文件后、加上有意的交接 mention 之前，执行：

```bash
perl -pi -e 's#\[@?([^\]]*)\]\(mention://(agent|squad)/[^)]*\)#\@$1#g; s#mention://(agent|squad)/#mention:‹$1›/#g' <正文文件>
```

第一段把 `[@名字](mention://agent/<id>)`、`[@名字](mention://squad/<id>)` 换成纯文本 `@名字`；第二段把剩下裸露的 `mention://agent/`、`mention://squad/` 前缀改成 `mention:‹agent›/`、`mention:‹squad›/`，不再被解析。这条命令对交接 mention 一视同仁，所以交接用的那一行放在清理之后再追加——「交接」一节的交接命令已经按这个顺序做了，交接评论不用再单独跑。

完成判据：发出前执行 `grep -cE 'mention://(agent|squad)/' <正文文件>`，输出等于这条评论**有意**交接的次数：交接评论是 `1`，其余是 `0`。`grep -c` 数的是行，交接 mention 单独占一行。

## 建票前查重

任何 `multica issue create` 之前都先查重：票面要求「另建跟踪票」、Mika 建父 issue 或子 issue、追加修订票都算。`orchestrate` 的「已有子 issue 就不再建」只看一个父 issue，防不住同一问题从两条路径各建一张（SKIL-81：新父 SKIL-80 下还没有子 issue，但同一个 D6 已经有挂在 SKIL-77 下的 SKIL-79，结果两张都开工、各出一个 PR）。

1. **分清要建哪一种票**：父 issue，还是执行票或跟踪票（stage 子 issue、拆票、修订票、「另建跟踪票」都算后一种）。
2. **定两组关键词**：
   - **问题关键词**：问题编号（`D6`、`Task 3`）或一句话里的核心名词。它只在同一份来源文档里唯一，换一份文档，`D6`、`Task 1` 就会撞号，所以不能单独作为判据。
   - **来源锚点**：本票指向的来源，至少取一个：spec 路径 `specs/<slug>/`、代码位置（`state-root.ts:72`）或函数名、来源 issue 的 KEY、设计稿路径。

   请求或描述里点名了现有 KEY（「把 SKIL-79 指派给…」）时，如果要建的票和点名的票**是同一种**（都是执行票或跟踪票），点名的那张就是要用的票，跳到第 5 步复用。建父 issue 时不跳：点名的 KEY 写进父 issue 描述，照常走第 3、4 步，交给父 issue 的首次路由 run 去复用。
3. **搜**：两组关键词各跑一次，必须带 `--include-closed`（不带时已完成的票搜不出来）：
   ```bash
   multica issue search "<关键词>" --include-closed --limit 20 --output json
   multica issue children <目标父 issue> --output json
   multica issue children <来源 issue> --output json   # 跟踪票通常挂在来源 issue 下
   ```
4. **判定**：从结果里去掉本 issue、目标父 issue、来源 issue。剩下的票，同时满足下面两条才算**重复**：
   - (a) 标题含问题关键词，或者和要建的票标题说的是同一件事；
   - (b) 描述里有同一个来源锚点，也就是同一个 `specs/<slug>/`、同一个代码位置或函数，或者同一个来源 KEY。

   只满足一条的（比如别的 spec 的 `Task 1`、别的文档的 `D6`）**不算重复**，在评论里列出来，写明「同号不同源」。建父 issue 时，只和已有的**父 issue**（`parent_issue_id` 为空）比；搜到的执行票、跟踪票不算重复，把它的 KEY 写进父 issue 描述。(a)(b) 看不出来时，采用默认答案「不算重复，新建」，写明 `采用默认答案，成员可推翻` 后继续；只有判断会造成不可逆、权限或花费影响时才按「提问」等待成员。
5. **处理**（只对第 4 步判定为重复、也就是来源相同的票）：

   | 重复票的状态 | 做法 |
   |---|---|
   | 未完成（不是 `done` / `cancelled`） | 复用，不新建：`multica issue update <KEY> --parent <目标父> --stage <N> --description-file ./child.md`，再按需 `assign`、`status todo` |
   | `done` | 不新建。在本 issue 上写明已由 `<KEY>` 完成；确有遗留时才新建，描述第一行写「续 `<KEY>`」，只写遗留部分 |
   | `cancelled` | 可以新建，描述里写「替代已取消的 `<KEY>`」 |

6. **建后复查**：所有新票（包括父 issue 和修订票）都先建成 `backlog`，这时不会起 run。建完把第 3 步的搜索再跑一遍：如果出现一张 `created_at` 早于新票、状态不是 `cancelled`、按第 4 步判定为重复的票（并发的另一个 run 刚建的），就把新票置 `cancelled`，按第 5 步复用那张；否则按原计划置 `todo`。已经起了 run 的重复票，只置 `cancelled` 停不下来（SKIL-81 置 `cancelled` 后，Sleuth 的 run 照跑，又把它改回了 `in_review`）。要先用 `multica issue runs <KEY> --active` 找到进行中的 run，执行 `multica issue cancel-task <run-id> --issue <KEY>`，再置 `cancelled`。

完成判据：本次 run 的评论里写了用过的问题关键词、来源锚点和结论（「无重复，新建 `<KEY>`」「复用 `<KEY>`」或「同号不同源：`<KEY>`」）；新建的票在复查时没有更早的同源票；同一个问题关键词加同一个来源锚点下，未取消、未完成的票只有一张。

## spec 有问题时

实现中发现 spec 矛盾、缺失或写不通：把子 issue 置为 `blocked`，评论写清是 spec 的哪一处、为什么写不通、你建议怎么改，用「交接」一节的交接命令发出，`TO=Mika`。Mika 会追加一张 Spec Writer 修订票，修订合并后再放行你这张。
