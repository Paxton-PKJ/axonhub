---
description: "本 fork 的分支、PR、workflow 约定，以及同步上游的步骤"
---

# Fork 维护

`Paxton-PKJ/axonhub` 是 `looplj/axonhub` 的自用 fork。`main` 是唯一的长期分支，内容是上游已发版的代码加上只在本仓库使用的修改。上游的默认分支是 `unstable`。

克隆下来只有 `origin`。用到上游内容时先添加 remote：

```bash
git remote add upstream https://github.com/looplj/axonhub.git
```

## 分支和 PR

| 用途 | 分支名 | 从哪里切 | PR 目标 |
|------|--------|----------|---------|
| 同步上游 | `sync/<tag>` | `main` | `Paxton-PKJ/axonhub` 的 `main` |
| 只在本仓库使用的修改 | `feature/<名称>` 或 `fix/<名称>` | `main` | `Paxton-PKJ/axonhub` 的 `main` |
| 提交给官方的修改 | `pr/<名称>` | `upstream/unstable` | `looplj/axonhub` 的 `unstable` |

1. 一项工作只用一个分支和一个 PR。CI 失败时在原分支上继续提交，不要另开分支或 PR 来验证。
2. 不要直接推送 `main`。进入 `main` 的内容都经过 PR，检查全部通过后用 merge commit 合并。不要用 squash 或 rebase：它们会丢掉上游提交的祖先关系，下一次同步会把已经合并过的内容重新报成冲突。
3. PR 合并或关闭后删除分支。
4. 在 fork 里 `gh pr create` 默认把 PR 开到上游。开本仓库的 PR 时带上 `-R Paxton-PKJ/axonhub --base main`。
5. `pr/` 分支必须从 `upstream/unstable` 切。从 `main` 切会把本仓库独有的提交带进官方 PR。
6. 提交给官方的修改不合并进 `main`，也不要把上游的提交 cherry-pick 到 `main`。它们在上游发版后随同步回来；提前合并会在 `main` 上留下和上游重复的提交。
7. 不要在本仓库保留上游分支的副本（例如 `unstable`），也不要把上游的 tag 推到本仓库。

`pr/` 分支在本仓库不跑 CI，检查由官方 PR 运行。要在官方合并前试用，手动运行 `Fork Docker image (GHCR)`，把 `source_ref` 填成该分支。

## 同步上游

只同步上游的发版 tag，一个 tag 做一次同步。用户明确要求同步未发版的提交时，步骤相同，分支命名为 `sync/unstable-<短 sha>`。

1. 从 `main` 切出同步分支，取回 tag。下面的 `fetch` 不会在本地创建 tag。

   ```bash
   TAG=v1.0.0-rc.6
   git switch main && git pull --ff-only
   git switch -c "sync/$TAG"
   git fetch --no-tags upstream "refs/tags/$TAG"
   ```

2. 列出本仓库独有的提交。合并之后这些修改都要还在。

   ```bash
   git log --no-merges --oneline FETCH_HEAD..main
   ```

3. 合并。

   ```bash
   git merge --no-ff FETCH_HEAD -m "merge: sync upstream $TAG"
   ```

4. 解决冲突：
   - 生成代码不要手工合并。先解决 `internal/ent/schema/`、`*.graphql` 和 `gqlgen.yml` 的冲突，再运行 `make generate`，把它改动的文件全部提交。`Test` workflow 的 `Verify generated code is committed` 步骤会检查这一点。
   - 本仓库独有的功能和上游冲突时，保留功能，按上游的新接口改写。
   - 已经被上游收录的修改，取上游版本。
   - `.github/workflows/` 下的上游文件取上游版本，再补回 [Actions](#actions) 一节列出的改动。
   - `AGENTS.md` 保留「Fork 维护」一节。

5. 推送并开 PR。

   ```bash
   git push -u origin "sync/$TAG"
   gh pr create -R Paxton-PKJ/axonhub --base main --head "sync/$TAG" \
     --title "merge: sync upstream $TAG" --body "Sync upstream $TAG."
   ```

6. 检查全部通过后合并。合并产生的 `main` push 会触发 `Fork Docker image (GHCR)` 构建镜像。

   ```bash
   gh pr merge "sync/$TAG" -R Paxton-PKJ/axonhub --merge --delete-branch
   ```

7. 同步带来新的 workflow 文件时，看它的触发条件。由定时、tag 或发布触发而本仓库用不到的，用 `gh workflow disable <文件名> -R Paxton-PKJ/axonhub` 禁用。

## Actions

1. 本仓库独有的 workflow 只有 `.github/workflows/docker-fork.yml`。不要新增 workflow 文件。确实需要新的 CI 行为时，先征得用户同意。
2. 不要删除或重命名上游的 workflow 文件，否则每次同步都会冲突。用不到的在 Actions 页面禁用。
3. 这些 workflow 保持禁用：`desktop-release.yml`、`docker-publish.yml`、`docker-unstable.yml`、`release.yml`、`stale.yml`、`sync-model-developers.yml`、`vulncheck.yml`。
4. 对上游 workflow 文件的改动只有下面这些，同步时要保留，不要再加：
   - `build.yml`、`lint.yml`、`test.yml`、`docker-pr.yml`：`pull_request.branches` 多一项 `main`。
   - `test.yml`：`Verify generated code is committed`、`Upload generated code patch` 两个步骤，以及 `typecheck-frontend` job。

触发结果：

| 事件 | 运行的 workflow |
|------|-----------------|
| PR 到 `main` | `Build`、`Lint`、`Test`、`Docker build (PR)` |
| push 到 `main` | `Fork Docker image (GHCR)` |
| 其他分支的 push | 无 |

分支上的 push 不触发 CI，所以检查结果在 PR 上看。
