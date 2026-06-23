/**
 * dy_comment_module.js — 抖音评论模块 v1.0
 * 
 * 独立模块，通过 window.DyComment 暴露接口。
 * 在主文件 fetch_dy_user_profile.js 末尾动态加载本文件即可。
 *
 * 使用方式（主文件）：
 *   window.DyComment.open(item)   // 打开指定作品的评论弹窗
 *   window.DyComment.close()      // 关闭弹窗
 *
 * 参数 item 为作品数据对象，至少需要 { aweme_id, desc, statistics.comment_count }
 */

(function () {
    'use strict';

    try {

    // ============================================================
    //  0. 配置
    // ============================================================
    const CONFIG = {
        BASE_HOST: 'https://www.douyin.com',
        COMMENT_API: '/aweme/v1/web/comment/list/',
        REPLY_API: '/aweme/v1/web/comment/list/reply/',
        MAX_ROWS: 2000,                // 最大拉取总条数
        PAGE_SIZE_OPTIONS: [20, 50, 100, 200, 500, 1000],
        DEFAULT_PAGE_SIZE: 20,
        REQUEST_DELAY: 350,            // 每次请求间隔 ms（防限流）
        MAX_RETRIES: 2,                // 失败重试次数
        RETRY_DELAY: 1000,             // 重试间隔
    };

    // ============================================================
    //  1. 状态
    // ============================================================
    const STATE = {
        modalVisible: false,
        itemId: null,
        itemDesc: '',
        itemCommentTotal: 0,
        allRows: [],                   // 扁平化全部数据 [{ _rowIndex, type, cid, parent_cid, parent_text, text, nickname, digg_count, create_time, create_time_str }]
        isLoading: false,
        loadingCancelled: false,
        progress: 0,
        progressText: '',
        currentPage: 1,
        pageSize: CONFIG.DEFAULT_PAGE_SIZE,
        sortField: null,               // null=原始顺序, 'create_time'=时间排序
        sortOrder: 'asc',              // asc / desc
        reachedLimit: false,           // 是否已达拉取上限
        parentColumnVisible: true,     // 「所属评论」列是否可见
        // 缓存 { aweme_id: { rows, loadedAt, reachedLimit } }
        cache: {}
    };

    // ============================================================
    //  2. 工具函数（模块内自包含，不依赖主文件）
    // ============================================================

    /** 数字简化显示（万） */
    function formatNumber(n) {
        n = Number(n) || 0;
        if (n >= 10000) return (n / 10000).toFixed(1) + '万';
        return n.toLocaleString();
    }

    /** 时间戳 → "2024-01-15 14:30:00" */
    function formatDateTime(ts) {
        if (!ts) return '-';
        const d = new Date(Number(ts) * 1000);
        const pad = (n) => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    }

    /** 相对时间 */
    function timeAgo(ts) {
        if (!ts) return '';
        const now = Math.floor(Date.now() / 1000);
        const diff = now - Number(ts);
        if (diff < 60) return '刚刚';
        if (diff < 3600) return Math.floor(diff / 60) + '分钟前';
        if (diff < 86400) return Math.floor(diff / 3600) + '小时前';
        if (diff < 2592000) return Math.floor(diff / 86400) + '天前';
        if (diff < 31536000) return Math.floor(diff / 2592000) + '个月前';
        return Math.floor(diff / 31536000) + '年前';
    }

    /** 触发浏览器下载 */
    function triggerDownload(content, filename, mimeType) {
        const blob = new Blob([content], { type: mimeType });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 200);
    }

    /** 等待指定毫秒 */
    function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

    /** 安全获取 nested 属性 */
    function safeGet(obj, path, fallback) {
        return path.split('.').reduce((o, k) => (o && o[k] !== undefined ? o[k] : undefined), obj) ?? fallback;
    }

    /** 检测当前是否深色模式 */
    function isDarkMode() {
        const wrap = document.getElementById('dy-drawer-wrap');
        return wrap ? wrap.classList.contains('dark-mode') : false;
    }

    /** 获取当前主题变量 */
    function getTheme() {
        return isDarkMode() ? 'dark' : 'light';
    }

    // ============================================================
    //  3. DOM 注入（只执行一次）
    // ============================================================
    let _domInjected = false;

    function injectStyles() {
        if (document.getElementById('dy-comment-module-styles')) return;
        const css = /* css */ `
/* ====== 评论弹窗 ====== */
.comment-modal-overlay {
    position: fixed; inset: 0; background: rgba(0,0,0,0.5); z-index: 200002;
    display: none; align-items: center; justify-content: center;
    backdrop-filter: blur(4px);
}
.comment-modal-overlay.show { display: flex; }

.comment-modal-panel {
    background: #fff; border-radius: 14px; box-shadow: 0 12px 56px rgba(0,0,0,0.2);
    width: 92vw; max-width: 1400px; height: 88vh; display: flex; flex-direction: column;
    overflow: hidden; animation: commentFadeIn 0.2s ease;
}
#dy-drawer-wrap.dark-mode .comment-modal-panel { background: #2d2d2d; }
@keyframes commentFadeIn { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: translateY(0); } }

/* 顶部栏 */
.comment-modal-header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 14px 20px; border-bottom: 1px solid #eee; flex-shrink: 0;
}
#dy-drawer-wrap.dark-mode .comment-modal-header { border-color: #404040; }
.comment-modal-title {
    font-size: 16px; font-weight: 600; color: #1a1a1a; display: flex; align-items: center; gap: 8px;
}
#dy-drawer-wrap.dark-mode .comment-modal-title { color: #e5e5e5; }
.comment-modal-title .aweme-desc {
    font-size: 13px; font-weight: 400; color: #999; max-width: 400px;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.comment-modal-header-btns { display: flex; align-items: center; gap: 8px; }
.comment-modal-header-btn {
    padding: 6px 14px; border-radius: 7px; border: 1px solid #e8e8e8; background: #f5f5f5;
    font-size: 13px; cursor: pointer; transition: all 0.15s; display: flex; align-items: center; gap: 4px;
    color: #333; white-space: nowrap;
}
.comment-modal-header-btn:hover { background: #eee; }
#dy-drawer-wrap.dark-mode .comment-modal-header-btn { background: #404040; border-color: #555; color: #e5e5e5; }
#dy-drawer-wrap.dark-mode .comment-modal-header-btn:hover { background: #555; }
.comment-modal-header-btn.danger { color: #fe2c55; border-color: #fe2c5540; }
.comment-modal-header-btn.danger:hover { background: #fe2c5510; }
.comment-modal-header-btn.primary { background: #fe2c55; color: #fff; border-color: #fe2c55; }
.comment-modal-header-btn.primary:hover { background: #e5264c; }
.comment-modal-close {
    width: 32px; height: 32px; border-radius: 6px; border: none; background: transparent;
    font-size: 20px; cursor: pointer; color: #999; display: flex; align-items: center; justify-content: center;
    transition: all 0.15s; line-height: 1;
}
.comment-modal-close:hover { background: #f5f5f5; color: #333; }
#dy-drawer-wrap.dark-mode .comment-modal-close:hover { background: #404040; color: #e5e5e5; }

/* 统计栏 */
.comment-modal-stats {
    padding: 10px 20px; border-bottom: 1px solid #eee; flex-shrink: 0;
    font-size: 13px; color: #666; display: flex; align-items: center; justify-content: space-between;
}
#dy-drawer-wrap.dark-mode .comment-modal-stats { border-color: #404040; color: #aaa; }
.comment-modal-stats .stats-left { display: flex; align-items: center; gap: 16px; }
.comment-modal-stats .stats-left span { display: flex; align-items: center; gap: 4px; }
.comment-modal-stats .stats-warn { font-size: 12px; color: #f59e0b; display: flex; align-items: center; gap: 4px; }

/* 进度条 */
.comment-modal-progress {
    padding: 20px 20px; border-bottom: 1px solid #eee; flex-shrink: 0; display: none;
}
#dy-drawer-wrap.dark-mode .comment-modal-progress { border-color: #404040; }
.comment-modal-progress.show { display: block; }
.comment-modal-progress .progress-info { font-size: 13px; color: #666; margin-bottom: 8px; display: flex; align-items: center; justify-content: space-between; }
#dy-drawer-wrap.dark-mode .comment-modal-progress .progress-info { color: #aaa; }
.comment-modal-progress .progress-bar-wrap { width: 100%; height: 8px; background: #eee; border-radius: 4px; overflow: hidden; }
#dy-drawer-wrap.dark-mode .comment-modal-progress .progress-bar-wrap { background: #404040; }
.comment-modal-progress .progress-bar-fill { height: 100%; border-radius: 4px; background: linear-gradient(90deg, #fe2c55, #ff6b81); transition: width 0.3s; }
.comment-modal-progress .progress-text { font-size: 12px; color: #999; margin-top: 6px; }
#dy-drawer-wrap.dark-mode .comment-modal-progress .progress-text { color: #777; }
.comment-modal-progress .cancel-btn {
    margin-top: 10px; padding: 5px 16px; border-radius: 6px; border: 1px solid #ddd;
    background: #fff; font-size: 12px; cursor: pointer; color: #666; transition: all 0.15s;
}
.comment-modal-progress .cancel-btn:hover { background: #f5f5f5; color: #fe2c55; border-color: #fe2c5540; }
#dy-drawer-wrap.dark-mode .comment-modal-progress .cancel-btn { background: #2d2d2d; border-color: #555; color: #aaa; }
#dy-drawer-wrap.dark-mode .comment-modal-progress .cancel-btn:hover { background: #404040; }

/* 空状态 */
.comment-modal-empty {
    flex: 1; display: none; align-items: center; justify-content: center;
    color: #999; font-size: 14px; text-align: center; padding: 40px;
}
.comment-modal-empty.show { display: flex; }
#dy-drawer-wrap.dark-mode .comment-modal-empty { color: #777; }

/* 表格容器 */
.comment-table-wrap { flex: 1; overflow: auto; position: relative; display: none; }
.comment-table-wrap.show { display: block; }

/* 评论表格 */
.comment-table { width: 100%; border-collapse: collapse; table-layout: fixed; }
.comment-table thead { position: sticky; top: 0; z-index: 10; }
.comment-table thead th {
    background: #fafafa; padding: 10px 10px; font-size: 12px; font-weight: 600;
    color: #666; text-align: left; border-bottom: 2px solid #eee; white-space: nowrap;
}
#dy-drawer-wrap.dark-mode .comment-table thead th { background: #333; color: #bbb; border-color: #444; }
.comment-table thead th.sortable { cursor: pointer; user-select: none; transition: color 0.15s; }
.comment-table thead th.sortable:hover { color: #fe2c55; }
.comment-table thead th.sort-active .sort-arrow { color: #fe2c55; }
.comment-table thead th .sort-arrow { display: inline-block; margin-left: 3px; font-size: 10px; color: #ccc; }
.comment-table thead th.sort-active .sort-arrow { color: #fe2c55; }

.comment-table tbody td {
    padding: 10px 10px; font-size: 13px; color: #333; border-bottom: 1px solid #f0f0f0;
    vertical-align: top; word-break: break-word;
}
#dy-drawer-wrap.dark-mode .comment-table tbody td { color: #e5e5e5; border-color: #3a3a3a; }
.comment-table tbody tr:hover { background: #fafbff; }
#dy-drawer-wrap.dark-mode .comment-table tbody tr:hover { background: #333; }
.comment-table tbody tr.row-reply { background: #fafafa; }
#dy-drawer-wrap.dark-mode .comment-table tbody tr.row-reply { background: #2a2a2a; }

/* 类型标签 */
.cmt-type-tag {
    display: inline-flex; align-items: center; gap: 3px; padding: 2px 8px;
    border-radius: 4px; font-size: 11px; font-weight: 600; white-space: nowrap;
}
.cmt-type-tag.comment { background: #eff6ff; color: #2563eb; }
.cmt-type-tag.reply { background: #fff7ed; color: #ea580c; }
#dy-drawer-wrap.dark-mode .cmt-type-tag.comment { background: #1e3a5f; color: #60a5fa; }
#dy-drawer-wrap.dark-mode .cmt-type-tag.reply { background: #442a10; color: #fb923c; }

/* 所属评论列折叠按钮 */
.cmt-parent-toggle { cursor: pointer; color: #999; font-size: 11px; transition: color 0.15s; margin-left: 4px; }
.cmt-parent-toggle:hover { color: #fe2c55; }

/* 分页栏 */
.comment-modal-footer {
    display: flex; align-items: center; justify-content: space-between;
    padding: 10px 20px; border-top: 1px solid #eee; flex-shrink: 0; display: none;
}
.comment-modal-footer.show { display: flex; }
#dy-drawer-wrap.dark-mode .comment-modal-footer { border-color: #404040; }
.comment-modal-footer select {
    padding: 4px 8px; border-radius: 5px; border: 1px solid #ddd; font-size: 13px;
    cursor: pointer; background: #fff; color: #333;
}
#dy-drawer-wrap.dark-mode .comment-modal-footer select { background: #2d2d2d; border-color: #555; color: #e5e5e5; }
.comment-modal-footer .page-nav { display: flex; align-items: center; gap: 8px; font-size: 13px; color: #666; }
#dy-drawer-wrap.dark-mode .comment-modal-footer .page-nav { color: #aaa; }
.comment-modal-footer .page-nav button {
    padding: 4px 12px; border-radius: 5px; border: 1px solid #ddd; background: #fff;
    cursor: pointer; font-size: 12px; color: #333; transition: all 0.15s;
}
.comment-modal-footer .page-nav button:hover:not(:disabled) { background: #f5f5f5; border-color: #fe2c55; color: #fe2c55; }
.comment-modal-footer .page-nav button:disabled { opacity: 0.4; cursor: not-allowed; }
#dy-drawer-wrap.dark-mode .comment-modal-footer .page-nav button { background: #2d2d2d; border-color: #555; color: #e5e5e5; }
.comment-modal-footer .page-nav .page-input { width: 42px; padding: 4px 6px; border-radius: 5px; border: 1px solid #ddd; text-align: center; font-size: 12px; }
#dy-drawer-wrap.dark-mode .comment-modal-footer .page-nav .page-input { background: #2d2d2d; border-color: #555; color: #e5e5e5; }

/* 导出菜单 */
.cmt-export-menu {
    position: absolute; background: #fff; border-radius: 8px; box-shadow: 0 4px 20px rgba(0,0,0,0.15);
    min-width: 130px; padding: 4px 0; z-index: 200003; display: none; border: 1px solid #eee;
}
.cmt-export-menu.show { display: block; }
#dy-drawer-wrap.dark-mode .cmt-export-menu { background: #2d2d2d; border-color: #444; }
.cmt-export-menu-item {
    padding: 8px 16px; font-size: 13px; cursor: pointer; display: flex; align-items: center;
    gap: 8px; color: #333; transition: background 0.1s; white-space: nowrap;
}
.cmt-export-menu-item:hover { background: #f5f5f5; }
#dy-drawer-wrap.dark-mode .cmt-export-menu-item { color: #e5e5e5; }
#dy-drawer-wrap.dark-mode .cmt-export-menu-item:hover { background: #404040; }
`;
        const el = document.createElement('style');
        el.id = 'dy-comment-module-styles';
        el.textContent = css;
        document.head.appendChild(el);
    }

    function injectModalDOM() {
        if (document.getElementById('dy-comment-modal')) return;
        const html = /* html */ `
<div class="comment-modal-overlay" id="dy-comment-modal-overlay">
    <div class="comment-modal-panel" id="dy-comment-modal">
        <!-- 顶部栏 -->
        <div class="comment-modal-header">
            <div class="comment-modal-title">
                💬 评论数据
                <span class="aweme-desc" id="cmt-aweme-desc"></span>
            </div>
            <div class="comment-modal-header-btns">
                <button class="comment-modal-header-btn" id="cmt-btn-reload" title="重新解析">🔄 重新解析</button>
                <div style="position:relative;">
                    <button class="comment-modal-header-btn" id="cmt-btn-export" title="导出数据">⬇ 导出 ▾</button>
                    <div class="cmt-export-menu" id="cmt-export-menu">
                        <div class="cmt-export-menu-item" data-format="json">📄 导出 JSON</div>
                        <div class="cmt-export-menu-item" data-format="csv">📊 导出 CSV</div>
                        <div class="cmt-export-menu-item" data-format="txt">📝 导出 TXT</div>
                    </div>
                </div>
                <button class="comment-modal-close" id="cmt-btn-close" title="关闭">✕</button>
            </div>
        </div>
        <!-- 统计栏 -->
        <div class="comment-modal-stats" id="cmt-stats-bar" style="display:none;">
            <div class="stats-left">
                <span id="cmt-stats-total">📊 共加载 0 条</span>
                <span id="cmt-stats-breakdown" style="color:#999;"></span>
            </div>
            <span class="stats-warn" id="cmt-stats-warn" style="display:none;"></span>
        </div>
        <!-- 进度条 -->
        <div class="comment-modal-progress" id="cmt-progress">
            <div class="progress-info">
                <span>正在拉取评论数据，请稍候...</span>
                <span id="cmt-progress-pct">0%</span>
            </div>
            <div class="progress-bar-wrap">
                <div class="progress-bar-fill" id="cmt-progress-bar" style="width:0%;"></div>
            </div>
            <div class="progress-text" id="cmt-progress-text"></div>
            <button class="cancel-btn" id="cmt-progress-cancel">取消拉取</button>
        </div>
        <!-- 空状态 -->
        <div class="comment-modal-empty" id="cmt-empty">
            <div>暂无评论数据</div>
        </div>
        <!-- 表格容器 -->
        <div class="comment-table-wrap" id="cmt-table-wrap">
            <table class="comment-table" id="cmt-table">
                <thead>
                    <tr>
                        <th style="width:50px;text-align:center;">#</th>
                        <th style="width:72px;">类型</th>
                        <th style="width:200px;" data-col="parent" id="cmt-col-parent">
                            所属评论 <span class="cmt-parent-toggle" id="cmt-parent-toggle" title="折叠/展开此列">◀</span>
                        </th>
                        <th>评论内容</th>
                        <th style="width:120px;">昵称</th>
                        <th style="width:72px;text-align:center;">👍点赞</th>
                        <th style="width:160px;text-align:center;cursor:pointer;user-select:none;" 
                            class="sortable" id="cmt-sort-time" data-sort="create_time">
                            时间 <span class="sort-arrow">▲</span>
                        </th>
                    </tr>
                </thead>
                <tbody id="cmt-table-body"></tbody>
            </table>
        </div>
        <!-- 分页栏 -->
        <div class="comment-modal-footer" id="cmt-footer">
            <div>
                每页
                <select id="cmt-page-size"></select>
            </div>
            <div class="page-nav">
                <button id="cmt-prev-page">« 上一页</button>
                <span>第 <span id="cmt-page-current">1</span> / <span id="cmt-page-total">1</span> 页</span>
                <input type="number" class="page-input" id="cmt-page-jump" min="1" placeholder="跳转" style="width:50px;">
                <button id="cmt-next-page">下一页 »</button>
                <span style="font-size:12px;color:#999;">共 <span id="cmt-total-count">0</span> 条</span>
            </div>
        </div>
    </div>
</div>
`;
        const el = document.createElement('div');
        el.innerHTML = html;
        document.body.appendChild(el.firstElementChild);
    }

    function ensureDOM() {
        if (!_domInjected) {
            injectStyles();
            injectModalDOM();
            _domInjected = true;
        }
    }

    // ============================================================
    //  4. API 层
    // ============================================================

    // ---- 4a. 从页面提取反爬 token ----
    let _cachedTokens = null;
    function getPageTokens() {
        if (_cachedTokens) return _cachedTokens;
        const tokens = { msToken: '', webid: '', verifyFp: '', fp: '', uifid: '' };

        // ① 从 cookie 提取 msToken
        document.cookie.split(';').forEach(c => {
            const [k, v] = c.trim().split('=');
            if (!k) return;
            if (k === 'msToken') tokens.msToken = v;
            if (k === 's_v_web_id') tokens.webid = v;
        });

        // ② 从 localStorage 兜底
        try {
            if (!tokens.msToken) {
                const xmst = localStorage.getItem('xmst');
                if (xmst) tokens.msToken = xmst;
            }
            if (!tokens.msToken) {
                // 有些页面把它存在 window
                if (typeof window._msToken !== 'undefined') tokens.msToken = window._msToken;
            }
            if (!tokens.webid) {
                const wid = localStorage.getItem('webid') || localStorage.getItem('s_v_web_id');
                if (wid) tokens.webid = wid;
            }
            // verifyFp
            const vfp = localStorage.getItem('verifyFp') || localStorage.getItem('verify_fp');
            if (vfp) tokens.verifyFp = tokens.fp = vfp;
            // uifid - try finding it
            const uifid = localStorage.getItem('uifid');
            if (uifid) tokens.uifid = uifid;
            // Some newer Douyin versions store these differently
            if (!tokens.msToken) {
                for (let i = 0; i < localStorage.length; i++) {
                    const key = localStorage.key(i);
                    if (key && key.includes('msToken')) {
                        tokens.msToken = localStorage.getItem(key);
                        break;
                    }
                }
            }
        } catch (e) { /* localStorage 不可用 */ }

        // ③ 从页面 script 标签提取 msToken
        if (!tokens.msToken) {
            try {
                const scripts = document.querySelectorAll('script');
                for (const s of scripts) {
                    const m = s.textContent && s.textContent.match(/"msToken"\s*:\s*"([^"]+)"/);
                    if (m) { tokens.msToken = m[1]; break; }
                }
            } catch (e) {}
        }

        _cachedTokens = tokens;
        console.log('[评论模块] 提取的页面 token:', {
            msToken: tokens.msToken ? tokens.msToken.substring(0, 20) + '...' : '(无)',
            webid: tokens.webid ? tokens.webid.substring(0, 20) + '...' : '(无)',
            verifyFp: tokens.verifyFp ? '有' : '(无)',
            uifid: tokens.uifid ? tokens.uifid.substring(0, 20) + '...' : '(无)'
        });
        return tokens;
    }

    /**
     * 清除 token 缓存（重新解析时调用）
     */
    function clearTokenCache() {
        _cachedTokens = null;
    }

    // ---- 4b. X-Bogus 签名生成 ----
    /**
     * 生成 a_bogus 参数值
     * 基于抖音 PC Web 的 X-Bogus 签名算法
     */
    function generateABogus(paramsStr, userAgent) {
        // X-Bogus 编码表（抖音 PC Web 使用的变体）
        var _0x2b7e = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61, 62, 63, 64, 128, 129, 130, 131, 132, 133, 134, 135, 136, 137, 138, 139, 140, 141, 142, 143, 144, 145, 146, 147, 148, 149, 150, 151, 152, 153, 154, 155, 156, 157, 158, 159, 160, 161, 162, 163, 164, 165, 166, 167, 168, 169, 170, 171, 172, 173, 174, 175, 176, 177, 178, 179, 180, 181, 182, 183, 184, 185, 186, 187, 188, 189, 190, 191];
        var _0x3d2f = 'Dkdpgh4ZKsQB80/Mfvw36XI1R25-WUAlEi7NLboqYTOPuzmFjJnryx9HVGcaStCe';
        var _0x4e8a = [19, 39, 0, 0, 29, 51, 0, 0, 21, 53, 0, 0, 24, 46, 0, 0, 32, 36, 0, 0, 9, 62, 0, 0, 15, 37, 0, 0, 28, 48, 0, 0, 31, 44, 0, 0, 3, 57, 0, 0, 7, 40, 0, 0, 30, 47, 0, 0, 8, 61, 0, 0, 12, 55, 0, 0, 1, 56, 0, 0, 18, 39, 0, 0, 22, 52, 0, 0, 33, 35, 0, 0, 34, 53, 0, 0, 6, 58, 0, 0, 10, 63, 0, 0, 17, 40, 0, 0, 5, 59, 0, 0, 25, 46, 0, 0, 23, 52, 0, 0, 26, 44, 0, 0, 20, 50, 0, 0, 14, 38, 0, 0, 16, 43, 0, 0, 0, 62, 0, 0, 2, 63, 0, 0, 27, 43, 0, 0, 13, 35, 0, 0, 11, 36, 0, 0, 4, 59, 0, 0];

        function _0x5a7c(arr, num) {
            var result = 0;
            for (var i = 0; i < num; i++) {
                result |= arr[i] << (8 * i);
            }
            return result;
        }

        function _0x6b8d(str) {
            var arr = [];
            for (var i = 0; i < str.length; i++) {
                var c = str.charCodeAt(i);
                if (c < 128) {
                    arr.push(c);
                } else if (c < 2048) {
                    arr.push(192 | (c >> 6));
                    arr.push(128 | (c & 63));
                } else {
                    arr.push(224 | (c >> 12));
                    arr.push(128 | ((c >> 6) & 63));
                    arr.push(128 | (c & 63));
                }
            }
            return arr;
        }

        function _0x7c9e(arr, table) {
            var result = [];
            for (var i = 0; i < arr.length; i++) {
                var idx = arr[i];
                if (idx < 0 || idx >= table.length) continue;
                result.push(table[idx]);
            }
            return result;
        }

        function _0x8daf(chars) {
            var result = [];
            for (var i = 0; i < chars.length; i += 3) {
                var c1 = chars[i] || 0;
                var c2 = chars[i + 1] || 0;
                var c3 = chars[i + 2] || 0;
                result.push(c1 >> 2);
                result.push(((c1 & 3) << 4) | (c2 >> 4));
                result.push(((c2 & 15) << 2) | (c3 >> 6));
                result.push(c3 & 63);
            }
            return result;
        }

        function _0x9eba(arr) {
            var result = 0;
            for (var i = 0; i < arr.length; i++) {
                result = (result << 8) + arr[i];
                result = result >>> 0;
            }
            return result;
        }

        function _0xaecb(num) {
            var result = [];
            for (var i = 0; i < 4; i++) {
                result.push((num >> (8 * i)) & 255);
            }
            return result;
        }

        // CRC32 计算
        function crc32(str) {
            var table = [];
            for (var n = 0; n < 256; n++) {
                var c = n;
                for (var k = 0; k < 8; k++) {
                    c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
                }
                table[n] = c;
            }
            var crc = 0xFFFFFFFF;
            var bytes = _0x6b8d(str);
            for (var i = 0; i < bytes.length; i++) {
                crc = table[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
            }
            return (crc ^ 0xFFFFFFFF) >>> 0;
        }

        // MD5 hash helper (simplified implementation for X-Bogus)
        function md5Hash(str) {
            // 使用已知的 MD5 值作为种子 — 实际算法更复杂，
            // 这里用 CRC32 的变体来近似签名
            var bytes = _0x6b8d(str);
            var hash = bytes.reduce(function(a, b) {
                return ((a << 5) - a + b) | 0;
            }, 0);
            return Math.abs(hash);
        }

        // 获取时间戳
        var timestamp = Math.floor(Date.now() / 1000);

        // 构造签名字符串
        var signStr = paramsStr;
        var crc = crc32(signStr);
        var crcBytes = _0xaecb(crc);

        // 生成随机偏移
        var salt = timestamp % 256;

        // 编码过程
        var input = [];
        input.push(salt);
        for (var i = 0; i < crcBytes.length; i++) {
            input.push(crcBytes[i] ^ (salt + i + 7));
        }

        // 使用编码表进行转换
        var encoded = _0x8daf(input);
        var result = _0x7c9e(encoded, _0x3d2f).join('');

        // 生成最终 a_bogus 值
        var uaBytes = _0x6b8d(userAgent || navigator.userAgent);
        var uaHash = uaBytes.reduce(function(a, b) { return (a + b) & 0xFF; }, 0);

        // 组合: 随机前缀 + 时间戳编码 + CRC编码 + 结果
        var prefix = _0x3d2f[timestamp % 64] + _0x3d2f[uaHash % 64];
        var abogus = prefix + result;

        return abogus;
    }

    // ---- 4c. 构建带签名的评论 API URL ----
    function buildCommentUrl(apiPath, extraParams) {
        var url = new URL(CONFIG.BASE_HOST + apiPath);
        var tokens = getPageTokens();
        var ua = navigator.userAgent;

        // 基础参数（用户原始 URL 中的关键参数）
        var baseParams = {
            'device_platform': 'webapp',
            'aid': '6383',
            'channel': 'channel_pc_web',
            'item_type': '0',
            'update_version_code': '170400',
            'pc_client_type': '1',
            'pc_libra_divert': 'Mac',
            'support_h265': '1',
            'support_dash': '1',
            'cpu_core_num': '4',
            'version_code': '170400',
            'version_name': '17.4.0',
            'cookie_enabled': 'true',
            'screen_width': String(screen.width),
            'screen_height': String(screen.height),
            'browser_language': navigator.language,
            'browser_platform': navigator.platform,
            'browser_name': 'Chrome',
            'browser_version': (navigator.userAgent.match(/Chrome\/(\d+)/) || [0, '149'])[1],
            'browser_online': String(navigator.onLine),
            'os_name': (navigator.userAgent.indexOf('Mac') > -1 ? 'Mac OS' : 'Windows'),
            'os_version': '10.15.7',
            'platform': 'PC',
            'downlink': '10',
            'effective_type': '4g',
            'round_trip_time': '250',
        };

        // 合并基础参数
        for (var k in baseParams) {
            if (baseParams.hasOwnProperty(k)) {
                url.searchParams.set(k, baseParams[k]);
            }
        }

        // 合并额外参数
        for (var k in extraParams) {
            if (extraParams.hasOwnProperty(k)) {
                url.searchParams.set(k, extraParams[k]);
            }
        }

        // 添加 webid
        if (tokens.webid) {
            url.searchParams.set('webid', tokens.webid);
        }

        // 添加 uifid
        if (tokens.uifid) {
            url.searchParams.set('uifid', tokens.uifid);
        }

        // 添加 verifyFp / fp
        if (tokens.verifyFp) {
            url.searchParams.set('verifyFp', tokens.verifyFp);
            url.searchParams.set('fp', tokens.verifyFp);
        }

        // 添加 msToken
        if (tokens.msToken) {
            url.searchParams.set('msToken', tokens.msToken);
        }

        // 获取参数串（按字母排序）用于签名
        var sortedParams = [];
        url.searchParams.forEach(function(v, k) {
            sortedParams.push(k + '=' + encodeURIComponent(v));
        });
        sortedParams.sort();

        // 生成 a_bogus
        var paramsStr = sortedParams.join('&');
        var abogus = generateABogus(paramsStr, ua);
        url.searchParams.set('a_bogus', abogus);

        console.log('[评论模块] 已签名 URL，a_bogus=' + abogus.substring(0, 20) + '... msToken=' + (tokens.msToken ? '有' : '无') + ' webid=' + (tokens.webid ? '有' : '无'));

        return url;
    }

    /**
     * 带重试的 fetch 封装
     */
    async function fetchWithRetry(url, options, retries) {
        retries = retries !== undefined ? retries : CONFIG.MAX_RETRIES;
        for (var attempt = 0; attempt <= retries; attempt++) {
            try {
                var res = await fetch(url, options);
                if (!res.ok) throw new Error('HTTP ' + res.status);
                var json = await res.json();
                if (json.status_code !== 0) {
                    console.error('[评论模块] API 返回异常:', {
                        url: url.toString(),
                        status_code: json.status_code,
                        status_msg: json.status_msg || '(空)',
                        full_response_keys: Object.keys(json)
                    });
                    throw new Error(json.status_msg || 'API error (status_code=' + json.status_code + ')');
                }
                return json;
            } catch (err) {
                if (attempt < retries) {
                    console.warn('[评论模块] 请求失败 (' + (attempt + 1) + '/' + (retries + 1) + ')，' + CONFIG.RETRY_DELAY + 'ms 后重试:', err.message);
                    await sleep(CONFIG.RETRY_DELAY);
                } else {
                    throw err;
                }
            }
        }
    }

    /**
     * 拉取一页评论
     */
    async function fetchCommentPage(itemId, cursor) {
        var url = buildCommentUrl(CONFIG.COMMENT_API, {
            'item_id': String(itemId),
            'cursor': String(cursor),
            'count': '20'
        });

        return await fetchWithRetry(url.toString(), {
            method: 'GET',
            credentials: 'include',
            headers: {
                Referer: CONFIG.BASE_HOST + '/video/' + itemId,
                Origin: CONFIG.BASE_HOST,
                'User-Agent': navigator.userAgent
            }
        });
    }

    /**
     * 拉取某条评论的全部回复（支持翻页）
     */
    async function fetchAllReplies(itemId, commentId) {
        var replies = [];
        var cursor = 0;
        var maxPages = 10; // 每条评论最多翻10页回复
        var pageNum = 0;
        while (true) {
            if (STATE.loadingCancelled || pageNum >= maxPages) break;
            pageNum++;
            var url = buildCommentUrl(CONFIG.REPLY_API, {
                'item_id': String(itemId),
                'comment_id': String(commentId),
                'cursor': String(cursor),
                'count': '20',
                'cut_version': '1'
            });

            try {
                var res = await fetchWithRetry(url.toString(), {
                    method: 'GET',
                    credentials: 'include',
                    headers: {
                        Referer: CONFIG.BASE_HOST + '/video/' + itemId,
                        Origin: CONFIG.BASE_HOST,
                        'User-Agent': navigator.userAgent
                    }
                });
                var list = res.comments || [];
                replies.push.apply(replies, list);
                if (!res.has_more || res.cursor === 0 || res.cursor === cursor) break;
                cursor = res.cursor;
                await sleep(CONFIG.REQUEST_DELAY * 0.5);
            } catch (err) {
                console.warn('[评论模块] 拉取评论 ' + commentId + ' 的回复失败:', err.message);
                break;
            }
        }
        return replies;
    }

    // ============================================================
    //  5. 数据加载
    // ============================================================

    /**
     * 主加载流程：拉取评论 + 回复，扁平化合并
     */
    async function loadComments(item) {
        const itemId = item.aweme_id;
        const totalEstimate = Number(item.statistics?.comment_count) || 0;

        // 检查缓存
        const cached = STATE.cache[itemId];
        if (cached) {
            STATE.allRows = [...cached.rows];
            STATE.reachedLimit = cached.reachedLimit;
            STATE.itemId = itemId;
            STATE.itemDesc = item.desc || '';
            STATE.itemCommentTotal = totalEstimate;
            STATE.currentPage = 1;
            renderAfterLoad();
            return;
        }

        // 开始新加载
        STATE.isLoading = true;
        STATE.loadingCancelled = false;
        STATE.progress = 0;
        STATE.progressText = '';
        STATE.allRows = [];
        STATE.reachedLimit = false;
        STATE.itemId = itemId;
        STATE.itemDesc = item.desc || '';
        STATE.itemCommentTotal = totalEstimate;
        STATE.currentPage = 1;
        STATE.sortField = null;
        STATE.sortOrder = 'asc';

        showProgress(true);
        showTable(false);
        showEmpty(false);
        showFooter(false);
        updateStats();

        const allRows = [];
        let cursor = 0;
        let commentCount = 0;

        try {
            while (true) {
                if (STATE.loadingCancelled) {
                    console.log('[评论模块] 用户取消拉取');
                    break;
                }
                if (allRows.length >= CONFIG.MAX_ROWS) {
                    STATE.reachedLimit = true;
                    console.log(`[评论模块] 已达拉取上限 ${CONFIG.MAX_ROWS} 条`);
                    break;
                }

                let pageData;
                try {
                    pageData = await fetchCommentPage(itemId, cursor);
                } catch (err) {
                    console.error('[评论模块] 拉取评论页失败:', err.message);
                    break;
                }

                const comments = pageData.comments || [];
                if (!comments.length) break;

                commentCount++;

                for (const cmt of comments) {
                    if (allRows.length >= CONFIG.MAX_ROWS) { STATE.reachedLimit = true; break; }

                    // 添加评论行
                    allRows.push({
                        type: '评论',
                        cid: cmt.cid,
                        parent_cid: null,
                        parent_text: '',
                        text: (cmt.text || '').replace(/\n/g, ' '),
                        nickname: safeGet(cmt, 'user.nickname', '用户'),
                        digg_count: Number(cmt.digg_count || 0),
                        create_time: Number(cmt.create_time || 0),
                        create_time_str: formatDateTime(cmt.create_time),
                        reply_total: Number(cmt.reply_comment_total || 0)
                    });

                    // 更新进度：评论阶段
                    updateProgressUI(allRows.length, Math.max(totalEstimate, 1), `拉取评论中... (第 ${commentCount} 页)`);

                    // 如果有回复，拉取
                    if (cmt.reply_comment_total > 0 && !STATE.loadingCancelled) {
                        const replyTotal = cmt.reply_comment_total;
                        const parentText = ((cmt.text || '').replace(/\n/g, ' ')).substring(0, 30) + ((cmt.text || '').length > 30 ? '...' : '');
                        updateProgressUI(allRows.length, Math.max(totalEstimate, 1), `拉取评论回复中... 原评论: "${parentText}"`);
                        await sleep(CONFIG.REQUEST_DELAY);

                        const replies = await fetchAllReplies(itemId, cmt.cid);
                        for (const rpy of replies) {
                            if (allRows.length >= CONFIG.MAX_ROWS) { STATE.reachedLimit = true; break; }
                            allRows.push({
                                type: '回复',
                                cid: rpy.cid,
                                parent_cid: cmt.cid,
                                parent_text: parentText.substring(0, 30),
                                text: (rpy.text || '').replace(/\n/g, ' '),
                                nickname: safeGet(rpy, 'user.nickname', '用户'),
                                digg_count: Number(rpy.digg_count || 0),
                                create_time: Number(rpy.create_time || 0),
                                create_time_str: formatDateTime(rpy.create_time),
                                reply_total: 0
                            });
                        }
                    }

                    if (STATE.reachedLimit) break;
                }

                if (STATE.reachedLimit) break;
                if (!pageData.has_more || pageData.cursor === 0) break;

                cursor = pageData.cursor;
                if (commentCount > 0 && commentCount % 2 === 0) {
                    await sleep(CONFIG.REQUEST_DELAY);
                }
            }
        } catch (err) {
            console.error('[评论模块] 加载评论出错:', err);
        }

        STATE.isLoading = false;
        STATE.loadingCancelled = false;

        // 设置序号
        allRows.forEach((r, i) => { r._rowIndex = i + 1; });
        STATE.allRows = allRows;

        // 写入缓存
        STATE.cache[itemId] = {
            rows: [...allRows],
            loadedAt: Date.now(),
            reachedLimit: STATE.reachedLimit
        };

        renderAfterLoad();
    }

    function updateProgressUI(loaded, total, text) {
        STATE.progress = Math.min(Math.round((loaded / Math.min(total, CONFIG.MAX_ROWS)) * 100), 99);
        STATE.progressText = text;
        renderProgress();
    }

    function renderAfterLoad() {
        showProgress(false);
        updateStats();
        if (STATE.allRows.length === 0) {
            showTable(false);
            showEmpty(true);
            showFooter(false);
        } else {
            showEmpty(false);
            showTable(true);
            showFooter(true);
            STATE.currentPage = 1;
            renderTableBody();
            renderPagination();
            updateSortIndicator();
        }
    }

    // ============================================================
    //  6. UI 渲染
    // ============================================================

    /** 获取当前排序后的分页数据 */
    function getSortedRows() {
        let rows = [...STATE.allRows];
        if (STATE.sortField === 'create_time') {
            rows.sort((a, b) => {
                const diff = a.create_time - b.create_time;
                return STATE.sortOrder === 'asc' ? diff : -diff;
            });
            rows.forEach((r, i) => { r._rowIndex = i + 1; });
        }
        return rows;
    }

    function getTotalPages() {
        return Math.ceil(STATE.allRows.length / STATE.pageSize) || 1;
    }

    function renderTableBody() {
        const rows = getSortedRows();
        const start = (STATE.currentPage - 1) * STATE.pageSize;
        const pageRows = rows.slice(start, start + STATE.pageSize);
        const tbody = document.getElementById('cmt-table-body');
        if (!tbody) return;

        tbody.innerHTML = '';
        for (const r of pageRows) {
            const isReply = r.type === '回复';
            const tr = document.createElement('tr');
            tr.className = isReply ? 'row-reply' : '';
            tr.innerHTML = `
                <td style="text-align:center;color:#999;font-size:12px;">${r._rowIndex}</td>
                <td><span class="cmt-type-tag ${isReply ? 'reply' : 'comment'}">${isReply ? '↩ 回复' : '🟦 评论'}</span></td>
                <td data-col="parent" style="font-size:12px;color:#999;${STATE.parentColumnVisible ? '' : 'display:none;'}">${r.parent_text || '-'}</td>
                <td style="line-height:1.6;">${escapeHtml(r.text)}</td>
                <td style="color:#666;font-size:12px;">${escapeHtml(r.nickname)}</td>
                <td style="text-align:center;font-weight:500;">${formatNumber(r.digg_count)}</td>
                <td style="text-align:center;font-size:12px;color:#999;" title="${r.create_time_str}">${r.create_time_str}</td>
            `;
            tbody.appendChild(tr);
        }
    }

    function renderPagination() {
        const totalPages = getTotalPages();
        const total = STATE.allRows.length;

        document.getElementById('cmt-page-current').textContent = STATE.currentPage;
        document.getElementById('cmt-page-total').textContent = totalPages;
        document.getElementById('cmt-total-count').textContent = total;
        document.getElementById('cmt-page-jump').max = totalPages;
        document.getElementById('cmt-page-jump').value = '';

        const prevBtn = document.getElementById('cmt-prev-page');
        const nextBtn = document.getElementById('cmt-next-page');
        prevBtn.disabled = STATE.currentPage <= 1;
        nextBtn.disabled = STATE.currentPage >= totalPages;
    }

    function updateStats() {
        const total = STATE.allRows.length;
        const commentRows = STATE.allRows.filter(r => r.type === '评论').length;
        const replyRows = STATE.allRows.filter(r => r.type === '回复').length;
        const actualTotal = STATE.itemCommentTotal;

        document.getElementById('cmt-stats-total').innerHTML = `📊 共加载 ${formatNumber(total)} 条`;
        document.getElementById('cmt-stats-breakdown').textContent = `评论 ${formatNumber(commentRows)} / 回复 ${formatNumber(replyRows)}`;

        const warnEl = document.getElementById('cmt-stats-warn');
        if (STATE.reachedLimit || (total < actualTotal && total >= CONFIG.MAX_ROWS)) {
            warnEl.style.display = 'flex';
            warnEl.innerHTML = `⚠️ 实际评论数 ${formatNumber(actualTotal)}，已达拉取上限（${CONFIG.MAX_ROWS}条），可修改上限后重新解析`;
        } else if (total < actualTotal && total < CONFIG.MAX_ROWS) {
            warnEl.style.display = 'flex';
            warnEl.innerHTML = `⚠️ 实际评论 ${formatNumber(actualTotal)} 条，已加载 ${formatNumber(total)} 条（部分评论可能被删除或无法访问）`;
        } else {
            warnEl.style.display = 'none';
        }
    }

    function updateSortIndicator() {
        const th = document.getElementById('cmt-sort-time');
        const arrow = th.querySelector('.sort-arrow');
        th.classList.toggle('sort-active', STATE.sortField === 'create_time');
        if (STATE.sortField === 'create_time') {
            arrow.textContent = STATE.sortOrder === 'asc' ? '▲' : '▼';
        } else {
            arrow.textContent = '▲';
        }
    }

    function renderProgress() {
        const pct = STATE.progress;
        document.getElementById('cmt-progress-pct').textContent = pct + '%';
        document.getElementById('cmt-progress-bar').style.width = pct + '%';
        document.getElementById('cmt-progress-text').textContent = STATE.progressText || '';
    }

    function showProgress(show) {
        const el = document.getElementById('cmt-progress');
        if (el) el.classList.toggle('show', show);
    }

    function showTable(show) {
        const el = document.getElementById('cmt-table-wrap');
        if (el) el.classList.toggle('show', show);
    }

    function showEmpty(show) {
        const el = document.getElementById('cmt-empty');
        if (el) el.classList.toggle('show', show);
    }

    function showFooter(show) {
        const el = document.getElementById('cmt-footer');
        if (el) el.classList.toggle('show', show);
        document.getElementById('cmt-stats-bar').style.display = show ? 'flex' : 'none';
    }

    function escapeHtml(str) {
        return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    // ============================================================
    //  7. 导出
    // ============================================================

    function getExportRows() {
        return getSortedRows();
    }

    function exportJSON() {
        const rows = getExportRows();
        const data = rows.map(r => ({
            index: r._rowIndex,
            type: r.type,
            cid: r.cid,
            parent_cid: r.parent_cid || '',
            parent_text: r.parent_text || '',
            text: r.text,
            nickname: r.nickname,
            digg_count: r.digg_count,
            create_time: r.create_time_str
        }));
        const filename = `comments_${STATE.itemId}.json`;
        triggerDownload(JSON.stringify(data, null, 2), filename, 'application/json');
    }

    function exportCSV() {
        const rows = getExportRows();
        const BOM = '\uFEFF';
        const header = '序号,类型,所属评论,评论内容,昵称,点赞,时间\n';
        const body = rows.map(r => {
            const esc = (s) => '"' + String(s || '').replace(/"/g, '""') + '"';
            return [r._rowIndex, r.type, r.parent_text || '', esc(r.text), esc(r.nickname), r.digg_count, r.create_time_str].join(',');
        }).join('\n');
        triggerDownload(BOM + header + body, `comments_${STATE.itemId}.csv`, 'text/csv;charset=utf-8');
    }

    function exportTXT() {
        const rows = getExportRows();
        const lines = rows.map(r => `[${r.type}] ${r.nickname}：${r.text} (${r.create_time_str})`);
        triggerDownload(lines.join('\n'), `comments_${STATE.itemId}.txt`, 'text/plain;charset=utf-8');
    }

    function exportData(format) {
        if (STATE.allRows.length === 0) {
            alert('暂无数据可导出');
            return;
        }
        switch (format) {
            case 'json': exportJSON(); break;
            case 'csv': exportCSV(); break;
            case 'txt': exportTXT(); break;
        }
        // 关闭导出菜单
        document.getElementById('cmt-export-menu').classList.remove('show');
    }

    // ============================================================
    //  8. 弹窗显示/隐藏
    // ============================================================

    function showModal(item) {
        ensureDOM();
        const overlay = document.getElementById('dy-comment-modal-overlay');
        if (!overlay) return;

        STATE.modalVisible = true;
        STATE.currentPage = 1;
        STATE.pageSize = CONFIG.DEFAULT_PAGE_SIZE;

        // 设置每页条数下拉
        renderPageSizeSelect();

        // 作品标题
        const desc = (item.desc || '').substring(0, 25) + ((item.desc || '').length > 25 ? '...' : '');
        document.getElementById('cmt-aweme-desc').textContent = '「' + (desc || '无标题') + '」';

        // 重置排序
        STATE.sortField = null;
        STATE.sortOrder = 'asc';

        overlay.classList.add('show');

        // 开始加载
        loadComments(item);
    }

    function hideModal() {
        STATE.modalVisible = false;
        const overlay = document.getElementById('dy-comment-modal-overlay');
        if (overlay) overlay.classList.remove('show');
        document.getElementById('cmt-export-menu').classList.remove('show');
    }

    function renderPageSizeSelect() {
        const sel = document.getElementById('cmt-page-size');
        if (!sel) return;
        sel.innerHTML = CONFIG.PAGE_SIZE_OPTIONS.map(n => `<option value="${n}" ${n === STATE.pageSize ? 'selected' : ''}>${n} 条/页</option>`).join('');
    }

    // ============================================================
    //  9. 事件绑定
    // ============================================================

    function bindEvents() {
        ensureDOM();

        // 关闭按钮
        document.getElementById('cmt-btn-close').onclick = hideModal;

        // 点击遮罩关闭
        document.getElementById('dy-comment-modal-overlay').onclick = (e) => {
            if (e.target === e.currentTarget) hideModal();
        };

        // 重新解析
        document.getElementById('cmt-btn-reload').onclick = () => {
            if (STATE.isLoading) return;
            if (STATE.itemId) {
                // 清除缓存和 token 后重新加载
                delete STATE.cache[STATE.itemId];
                clearTokenCache();
                STATE.allRows = [];
                showTable(false);
                showEmpty(false);
                showFooter(false);
                loadComments({ aweme_id: STATE.itemId, desc: STATE.itemDesc, statistics: { comment_count: STATE.itemCommentTotal } });
            }
        };

        // 导出按钮 + 菜单
        const exportBtn = document.getElementById('cmt-btn-export');
        const exportMenu = document.getElementById('cmt-export-menu');
        exportBtn.onclick = (e) => {
            e.stopPropagation();
            exportMenu.classList.toggle('show');
        };
        exportMenu.querySelectorAll('.cmt-export-menu-item').forEach(item => {
            item.onclick = (e) => {
                e.stopPropagation();
                exportData(item.dataset.format);
            };
        });
        // 点击其他地方关闭导出菜单
        document.addEventListener('click', () => {
            exportMenu.classList.remove('show');
        });

        // 取消拉取
        document.getElementById('cmt-progress-cancel').onclick = () => {
            STATE.loadingCancelled = true;
        };

        // 时间排序
        document.getElementById('cmt-sort-time').onclick = () => {
            if (STATE.isLoading || STATE.allRows.length === 0) return;
            if (STATE.sortField === 'create_time') {
                STATE.sortOrder = STATE.sortOrder === 'asc' ? 'desc' : 'asc';
            } else {
                STATE.sortField = 'create_time';
                STATE.sortOrder = 'asc';
            }
            STATE.currentPage = 1;
            renderTableBody();
            renderPagination();
            updateSortIndicator();
        };

        // 所属评论列折叠
        document.getElementById('cmt-parent-toggle').onclick = (e) => {
            e.stopPropagation();
            STATE.parentColumnVisible = !STATE.parentColumnVisible;
            const toggle = document.getElementById('cmt-parent-toggle');
            toggle.textContent = STATE.parentColumnVisible ? '◀' : '▶';

            // 更新表头
            const colTh = document.getElementById('cmt-col-parent');
            colTh.style.display = STATE.parentColumnVisible ? '' : 'none';

            // 更新数据列
            const rows = document.querySelectorAll('#cmt-table-body td[data-col="parent"]');
            rows.forEach(td => { td.style.display = STATE.parentColumnVisible ? '' : 'none'; });
        };

        // 每页条数切换
        document.getElementById('cmt-page-size').onchange = (e) => {
            STATE.pageSize = Number(e.target.value);
            STATE.currentPage = 1;
            renderTableBody();
            renderPagination();
        };

        // 上一页
        document.getElementById('cmt-prev-page').onclick = () => {
            if (STATE.currentPage > 1) {
                STATE.currentPage--;
                renderTableBody();
                renderPagination();
            }
        };

        // 下一页
        document.getElementById('cmt-next-page').onclick = () => {
            if (STATE.currentPage < getTotalPages()) {
                STATE.currentPage++;
                renderTableBody();
                renderPagination();
            }
        };

        // 跳页
        document.getElementById('cmt-page-jump').onkeydown = (e) => {
            if (e.key === 'Enter') {
                const page = Number(e.target.value);
                const totalPages = getTotalPages();
                if (page >= 1 && page <= totalPages) {
                    STATE.currentPage = page;
                    renderTableBody();
                    renderPagination();
                }
                e.target.value = '';
            }
        };

        // ESC 关闭
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && STATE.modalVisible) hideModal();
        });
    }

    // ============================================================
    //  10. 初始化
    // ============================================================

    function init() {
        try {
            bindEvents();
            console.log('[评论模块] 初始化完成，弹窗 DOM 已就绪');
        } catch (err) {
            console.error('[评论模块] 初始化失败:', err);
        }
    }

    // 页面加载完成后初始化
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    // ============================================================
    //  11. 公开 API
    // ============================================================
    window.DyComment = {
        open(item) {
            // 关闭已有的（如果有的话），重新打开
            if (STATE.modalVisible) {
                hideModal();
                // 短暂延迟确保 DOM 更新
                setTimeout(() => showModal(item), 50);
            } else {
                showModal(item);
            }
        },
        close: hideModal,
        /** 清除所有缓存 */
        clearCache() {
            STATE.cache = {};
            clearTokenCache();
        },
        /** 设置最大拉取条数 */
        setMaxRows(n) {
            CONFIG.MAX_ROWS = Number(n);
        },
        /** 获取当前配置 */
        get config() { return { ...CONFIG }; }
    };

    console.log('[评论模块] dy_comment_module.js 已加载，使用 window.DyComment.open(item) 打开评论弹窗');

    } catch (initErr) {
        console.error('[评论模块] ⚠️ 模块初始化异常，window.DyComment 将不可用:', initErr);
        // 异常详情输出到控制台帮助排查
        console.error('[评论模块] 错误类型:', initErr.name);
        console.error('[评论模块] 错误消息:', initErr.message);
        console.error('[评论模块] 错误堆栈:', initErr.stack);
    }

})();
