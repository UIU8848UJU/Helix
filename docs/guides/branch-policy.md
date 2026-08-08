# 分支与提交策略（Branch & Commit Policy）

> 定稿：2026-08-08。本策略约束 `requirements/`、`development/` 等工程流程产物在分支间的流转，防止污染 main。

## 分支模型

- `main`：只保留代码与文档。**禁止**出现 `requirements/`、`development/`、`.skillmatrix/`、`.codex/`、`.claude/`、`*.ndjson`（均已加入 `.gitignore`）。
- `develop`：允许且建议保留 `requirements/` 与 `development/` 流程产物；其余内容与 main 保持一致。

## 提交规则

1. 代码 / 文档改动：正常提交到当前分支。
2. `requirements/`、`development/` 只能提交到 `develop`，且必须强制添加：
   `git add -f requirements development`
3. main 上这些目录必须保持未跟踪（`.gitignore` 已覆盖）。

## 合并规则（重要）

- **禁止**直接 `git merge develop` 进 main：develop 中已跟踪的 `requirements/`、`development/` 会随合并进入 main（`.gitignore` 不拦截已跟踪文件）。
- 正确做法：**按提交逐个 cherry-pick** 代码改动：
  `git checkout main`
  `git cherry-pick <代码提交的commit>`
- 如确需整支合并：`git merge --no-commit develop` 后先执行
  `git rm --cached -r requirements development`，再 `git commit`。

## 常用操作

- 把流程产物放回 develop：
  `git checkout develop && git add -f requirements development && git commit -m "chore: workflow artifacts"`
- 检查 main 是否混入流程产物（应无输出）：
  `git ls-files | Select-String -Pattern "^(requirements|development|\.skillmatrix)/"`

## 注意

- `.gitignore` 只管未跟踪文件；一旦某分支跟踪了这些目录，切换 / 合并都会将其带过来，必须靠上面的流程规则保证。
- 历史提交中仍可能包含这些文件（未做历史重写），当前策略只约束后续提交。