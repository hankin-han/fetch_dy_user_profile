# 抖音评论模块 — 设计文档

> 版本：v1.0 | 日期：2026-06-23

---

## 一、概述

在作品列表页中，点击「评论数」可弹出评论弹窗，展示该作品的全部评论及回复数据。评论和回复统一为一级表格展示，支持分页、排序、导出、折叠等功能。

---

## 二、架构设计

### 2.1 双文件架构

```
fetch_dy_user_profile/
├── fetch_dy_user_profile.js        ← 主文件（3处改动）
└── dy_comment_module.js            ← 评论模块（独立，约1000行）
```

- 主文件末尾通过 `<script src="./dy_comment_module.js">` 动态加载模块
- 评论模块挂载在 `window.DyComment` 命名空间
- 主文件调用 `window.DyComment.open(item)` 打开弹窗

### 2.2 模块内部结构

```
dy_comment_module.js
├── 配置层   CommentConfig          ← 常量（上限、分页选项、请求延迟等）
├── 状态层   CommentState           ← 运行时状态
├── API层    fetchCommentPage       ← 拉取一页评论
│            fetchAllReplies        ← 拉取某条评论的全部回复
├── 数据层   扁平化 + 合并 + 排序
├── UI层     injectStyles/ModalDOM  ← 注入CSS和弹窗DOM
│            renderTableBody        ← 渲染评论表格
│            renderPagination       ← 渲染分页控件
│            renderProgress         ← 渲染进度条
├── 导出层   exportJSON/CSV/TXT
└── 公开API  window.DyComment = { open, close, clearCache, setMaxRows }
```

---

## 三、API 接口

### 3.1 评论列表

```
GET /aweme/v1/web/comment/list/
```

| 参数 | 说明 |
|------|------|
| `item_id` | 作品 ID（aweme_id） |
| `cursor` | 分页游标，首次传 0 |
| `count` | 每页条数（建议 20） |
| `item_type` | 固定 0 |

**返回关键字段：**

```json
{
  "comments": [{
    "cid": "评论ID",
    "text": "评论内容",
    "digg_count": 点赞数,
    "reply_comment_total": 回复总数,
    "user": { "nickname": "", "avatar_thumb": {} },
    "create_time": 时间戳
  }],
  "cursor": 下页游标,
  "has_more": 是否还有更多
}
```

### 3.2 回复列表

```
GET /aweme/v1/web/comment/list/reply/
```

| 参数 | 说明 |
|------|------|
| `item_id` | 作品 ID |
| `comment_id` | 父评论 ID |
| `cursor` | 分页游标 |
| `count` | 每页条数 |

**请求头：** `credentials: "include"` + `Referer` / `Origin`（复用抖音登录态）

---

## 四、数据拉取流程

```
open(item)
  │
  ├─ 缓存命中（同一 aweme_id）? → 直接渲染表格
  │
  └─ 缓存未命中 → 开始拉取
       │
       ├─ 显示进度条
       │
       ├─ LOOP: fetchCommentPage(cursor) → 获取一批评论
       │    │
       │    ├─ 每条评论 reply_comment_total > 0 → fetchAllReplies(cid)
       │    │    └─ LOOP: 翻页直到 has_more = false
       │    │
       │    ├─ 合并进 allRows[]
       │    ├─ 更新进度条
       │    └─ allRows.length >= MAX_ROWS → break（达上限）
       │
       ├─ 拉取完成 → 扁平化排序 → 隐藏进度条
       ├─ 写入缓存
       └─ 渲染表格
```

### 退出条件

1. `has_more = false` — 服务器明确没有更多
2. 总条数达到 `MAX_ROWS`（默认 2000 条）
3. 用户点击「取消」按钮
4. API 连续失败（重试 2 次后放弃）

---

## 五、数据结构（扁平化后）

每条评论/回复统一格式：

```javascript
{
    _rowIndex: 1,              // 全局序号（分页显示用）
    type: "评论" | "回复",
    cid: "评论ID",
    parent_cid: null | "父评论ID",
    parent_text: "",           // 回复类型：父评论内容（截断30字）
    text: "评论正文",
    nickname: "用户昵称",
    digg_count: 128,
    create_time: 1700000000,   // Unix 时间戳，用于排序
    create_time_str: "2024-01-15 14:30:00"
}
```

---

## 六、UI 布局

### 6.1 弹窗结构

```
┌───────────────────────────────────────────────────────────────┐
│ 顶部栏（固定）                                                 │
├───────────────────────────────────────────────────────────────┤
│ 统计栏（固定）                                                 │
├───────────────────────────────────────────────────────────────┤
│ 进度条区（首次加载时显示，完成后隐藏）                          │
├───────────────────────────────────────────────────────────────┤
│ 表格区（可滚动）                                               │
├───────────────────────────────────────────────────────────────┤
│ 分页栏（固定）                                                 │
└───────────────────────────────────────────────────────────────┘
```

### 6.2 顶部栏

```
💬 评论数据  「作品标题最多25字截断...」
                        [🔄 重新解析] [⬇ 导出 ▾] [✕ 关闭]
```

- **重新解析**：清空数据 → 重新拉取 → 重新渲染
- **导出下拉**：JSON / CSV / TXT
- **关闭**：隐藏弹窗，保留缓存（同作品再次打开秒开）

### 6.3 统计栏

```
📊 共加载 2,000 条（已达上限）  ·  评论 1,024 条  ·  回复 976 条
   ⚠️ 实际评论数 3,451，已达拉取上限（2000条），可修改上限后重新解析
```

### 6.4 表格列

| 列名 | 宽度 | 来源 | 排序 | 折叠 |
|------|------|------|------|------|
| # | 50px | 全局序号 | — | 否 |
| 类型 | 72px | `type`（评论/回复） | — | 否 |
| 所属评论 | 200px | `parent_text` | — | ✅ |
| 评论内容 | flex | `text` | — | 否 |
| 昵称 | 120px | `nickname` | — | 否 |
| 👍点赞 | 72px | `digg_count` | — | 否 |
| 时间 | 160px | `create_time` | ✅ 升/降序 | 否 |

**类型列视觉区分：**
- `评论` → 蓝色标签（`#eff6ff` 背景 + `#2563eb` 文字）
- `回复` → 橙色标签（`#fff7ed` 背景 + `#ea580c` 文字）

**所属评论列折叠：**
- 列头旁 `◀` 按钮，点击切换到 `▶` 并隐藏整列
- 状态仅在当前弹窗生命周期内有效

### 6.5 分页栏

```
每页 [20 ▾]    «  上一页   第 3 / 118 页  [  3  ] 跳转   下一页  »    共 2000 条
```

| 控件 | 说明 |
|------|------|
| 每页条数 | 下拉选择：20 / 50 / 100 / 200 / 500 / 1000 |
| 页导航 | « 上一页 / 下一页 » |
| 页跳转 | 输入框 + Enter 跳转 |
| 总数 | 共 N 条 |

> 分页为**前端分页**（数据全部加载后本地切页，不再请求接口）

---

## 七、进度条

首次加载时显示：

```
┌────────────────────────────────────────────┐
│  正在拉取评论数据，请稍候...               │
│  ▓▓▓▓▓▓▓▓▓▓▓▓░░░░░░░░  62%              │
│  已获取 830 条 / 预计 1,340 条            │
│  当前：拉取第 19 条评论的回复（3页）...   │
│                         [取消拉取]        │
└────────────────────────────────────────────┘
```

- 进度 = (已拉取数 / `comment_count`) × 100%
- 支持**取消拉取**，已获取的数据照常展示

---

## 八、排序

点击表头「时间」列切换排序：

- **默认**：按原始顺序（评论在前，其回复紧跟）
- **升序 ▲**：时间从早到晚
- **降序 ▼**：时间从晚到早

排序后序号 `_rowIndex` 重新计算，保持连续。

---

## 九、导出

导出**全量缓存数据**（不受当前分页影响）：

| 格式 | 文件名 | 内容说明 |
|------|--------|----------|
| JSON | `comments_{aweme_id}.json` | 完整结构化数组，带缩进 |
| CSV | `comments_{aweme_id}.csv` | BOM UTF-8，标准 CSV 含表头 |
| TXT | `comments_{aweme_id}.txt` | 每行：`[类型] 昵称：内容 (时间)` |

---

## 十、缓存策略

```javascript
cache = {
    "aweme_id": {
        rows: [...],        // 已拉取的扁平化数据
        loadedAt: timestamp, // 加载时间
        reachedLimit: false  // 是否达上限
    }
}
```

- **同作品重复点击**：直接用缓存，秒开
- **重新解析**：清除对应 aweme_id 的缓存，重新拉取
- **弹窗关闭再打开**：使用缓存
- **切换其他作品**：自动清除加载状态，加载新作品数据
- `window.DyComment.clearCache()` 清除所有缓存

---

## 十一、配置项

全部在 `dy_comment_module.js` 顶部的 `CONFIG` 对象中：

| 配置 | 默认值 | 说明 |
|------|--------|------|
| `MAX_ROWS` | 2000 | 最大拉取总条数 |
| `PAGE_SIZE_OPTIONS` | [20,50,100,200,500,1000] | 每页条数选项 |
| `DEFAULT_PAGE_SIZE` | 20 | 默认每页条数 |
| `REQUEST_DELAY` | 350ms | 请求间隔（防限流） |
| `MAX_RETRIES` | 2 | 失败重试次数 |
| `RETRY_DELAY` | 1000ms | 重试间隔 |

运行时修改上限：`window.DyComment.setMaxRows(5000)`

---

## 十二、主文件改动清单

| 位置 | 改动 | 行数 |
|------|------|------|
| `renderTable()` | 评论数 > 0 时渲染为 `.dy-comment-link` 可点击红色链接 | ~5 行 |
| 事件委托 | `#tableBody` 监听 `.dy-comment-link` 点击，调用 `window.DyComment.open()` | ~15 行 |
| 文件末尾 | `createElement('script')` 动态加载 `./dy_comment_module.js` | ~10 行 |

---

## 十三、兼容性

| 项目 | 处理 |
|------|------|
| API 限流 / 460 | 自动重试 2 次，间隔 1s |
| 无评论 | 显示「暂无评论数据」空状态 |
| 深色模式 | CSS 变量跟随 `#dy-drawer-wrap.dark-mode`，自动切换 |
| 弹窗宽度 | 默认 92vw，max-width 1400px |
| 长评论内容 | `word-break: break-word` 自动换行 |
| Cookie 登录态 | `credentials: "include"` 携带 |

---

## 十四、公开 API

```javascript
// 打开评论弹窗
window.DyComment.open(item)
// item: { aweme_id, desc, statistics: { comment_count } }

// 关闭弹窗
window.DyComment.close()

// 清除所有缓存
window.DyComment.clearCache()

// 设置最大拉取条数
window.DyComment.setMaxRows(5000)

// 获取当前配置（只读）
window.DyComment.config.MAX_ROWS
```
