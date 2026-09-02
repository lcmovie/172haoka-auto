// ==UserScript==
// @name         172号卡 - 商品上架与代理激活助手
// @namespace    https://haoka.lot-ml.com/
// @version      1.1.4
// @description  自动遍历宽带商品并上架；自动遍历代理商列表并激活到期代理
// @author       Codex
// @match        https://haoka.lot-ml.com/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    const CONFIG = {
        preferredPageSize: '90',
        agentPageSize: '20',
        actionTimeout: 30000,
        pageTimeout: 20000,
        interval: 300,
        maxRetriesPerProduct: 3,
    };

    let running = false;
    let stopRequested = false;
    let failedCount = 0;
    let submittedCount = 0;

    const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
    const text = (el) => (el?.textContent || '').trim();

    async function waitFor(test, timeout = CONFIG.actionTimeout, interval = CONFIG.interval) {
        const started = Date.now();
        while (Date.now() - started < timeout) {
            const result = test();
            if (result) return result;
            if (stopRequested) throw new Error('用户已停止');
            await sleep(interval);
        }
        throw new Error(`等待超时（${Math.round(timeout / 1000)} 秒）`);
    }

    function getCurrentPage() {
        return Number(text(document.querySelector('.layui-laypage-curr em:last-child'))) || 1;
    }

    function getProductId(button) {
        const row = button.closest('tr');
        const firstCell = row?.querySelector('td');
        return text(firstCell) || text(row).slice(0, 80) || '未知商品';
    }

    function getPublishButtons() {
        return [...document.querySelectorAll('button[lay-event="del"]')]
            .filter(btn => text(btn) === '上架' && btn.offsetParent !== null);
    }

    function findProductRow(productId) {
        return [...document.querySelectorAll('.layui-table-body tbody tr')]
            .find(row => text(row.querySelector('td')) === String(productId));
    }

    function findPublishButton(productId) {
        const row = findProductRow(productId);
        return [...(row?.querySelectorAll('button[lay-event="del"]') || [])]
            .find(btn => text(btn) === '上架' && btn.offsetParent !== null);
    }

    function isTableLoading() {
        return [...document.querySelectorAll('.layui-layer-loading, .layui-table-init')]
            .some(el => el.offsetParent !== null);
    }

    async function waitForTableReady(timeout = CONFIG.pageTimeout) {
        await waitFor(() => {
            const body = document.querySelector('.layui-table-body');
            const pager = document.querySelector('.layui-laypage');
            const rows = document.querySelectorAll('.layui-table-body tbody tr');
            return body && pager && rows.length > 0 && !isTableLoading();
        }, timeout);
        // Layui 在请求结束后仍会继续替换行节点，留出一个短暂稳定期。
        await sleep(800);
    }

    function setStatus(message, kind = 'normal') {
        const status = document.querySelector('#haoka-auto-status');
        if (!status) return;
        status.textContent = message;
        status.style.color = kind === 'error' ? '#ffb4b4' : kind === 'done' ? '#9dffb0' : '#fff';
    }

    function updateStats() {
        const stats = document.querySelector('#haoka-auto-stats');
        if (stats) {
            stats.textContent = `已点击确认 ${submittedCount} ｜跳过 ${failedCount} ｜第 ${getCurrentPage()} 页`;
        }
    }

    async function changePageSize(pageSize = CONFIG.preferredPageSize) {
        const select = document.querySelector('.layui-laypage-limits select');
        if (!select || ![...select.options].some(o => o.value === pageSize)) return;
        if (select.value === pageSize) return;

        const oldRows = document.querySelectorAll('.layui-table-body tbody tr').length;
        const oldFirstRow = document.querySelector('.layui-table-body tbody tr');
        select.value = pageSize;
        select.dispatchEvent(new Event('change', { bubbles: true }));
        await waitFor(() => {
            const rows = document.querySelectorAll('.layui-table-body tbody tr').length;
            return rows !== oldRows || (oldFirstRow && !oldFirstRow.isConnected);
        }, CONFIG.pageTimeout);
        await waitForTableReady();
    }

    async function jumpToFirstPage() {
        if (getCurrentPage() === 1) return;
        const input = document.querySelector('.layui-laypage-skip input');
        const button = document.querySelector('.layui-laypage-skip button');
        if (!input || !button) throw new Error('没有找到分页跳转控件');

        input.value = '1';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        button.click();
        await waitFor(() => getCurrentPage() === 1, CONFIG.pageTimeout);
        await waitForTableReady();
    }

    async function publishOne(button) {
        const productId = getProductId(button);
        setStatus(`正在上架商品 ${productId}…`);

        button.click();
        const confirmButton = await waitFor(() => {
            const dialogs = [...document.querySelectorAll('.layui-layer-dialog')];
            const dialog = dialogs.find(el => text(el).includes('确认要上下架吗'));
            return dialog?.querySelector('.layui-layer-btn0');
        });
        const confirmDialog = confirmButton.closest('.layui-layer-dialog');
        confirmButton.click();

        submittedCount++;
        updateStats();

        // 这里只等待本次确认框退出，确保下一件商品可以继续点击；不等待也不核验上架结果。
        await waitFor(() => !confirmDialog?.isConnected, 5000, 100).catch(() => {
            confirmDialog?.querySelector('.layui-layer-close')?.click();
        });
        await sleep(1000);
        return productId;
    }

    async function processCurrentPage() {
        // 进入页面时固定目标清单，保证当前页每个“上架”按钮只执行一次。
        const targets = [...new Set(getPublishButtons().map(getProductId))];

        for (const productId of targets) {
            if (stopRequested) break;
            const button = findPublishButton(productId);
            if (!button) {
                failedCount++;
                updateStats();
                continue;
            }

            try {
                await publishOne(button);
            } catch (error) {
                if (stopRequested) throw error;
                failedCount++;
                console.warn(`[自动上架] 商品 ${productId} 点击失败，已跳过：`, error);
                document.querySelector('.layui-layer-dialog .layui-layer-close')?.click();
                setStatus(`商品 ${productId} 点击失败，已跳过`, 'error');
                updateStats();
                await sleep(500);
            }
        }
    }

    async function goNextPage() {
        await waitForTableReady();
        const next = document.querySelector('.layui-laypage-next:not(.layui-disabled)');
        if (!next) return false;

        const oldPage = getCurrentPage();
        const oldFirstRow = text(document.querySelector('.layui-table-body tbody tr'));
        next.click();
        await waitFor(() => getCurrentPage() !== oldPage || text(document.querySelector('.layui-table-body tbody tr')) !== oldFirstRow, CONFIG.pageTimeout);
        await waitForTableReady();
        return true;
    }

    async function run() {
        if (running) return;
        if (!window.confirm('将从第 1 页开始，自动上架所有页面中的全部待上架商品。\n\n确定开始吗？')) return;

        running = true;
        stopRequested = false;
        failedCount = 0;
        submittedCount = 0;
        document.querySelector('#haoka-auto-start').disabled = true;
        document.querySelector('#haoka-auto-stop').disabled = false;

        try {
            setStatus('正在调整分页并回到第 1 页…');
            await changePageSize();
            await jumpToFirstPage();

            while (!stopRequested) {
                updateStats();
                setStatus(`正在处理第 ${getCurrentPage()} 页…`);
                await processCurrentPage();
                if (stopRequested) break;
                if (!(await goNextPage())) {
                    setStatus(`全部点击完成：已确认 ${submittedCount}，跳过 ${failedCount}`,
                        failedCount > 0 ? 'error' : 'done');
                    alert(`自动上架点击完成！\n已点击确认：${submittedCount}\n跳过：${failedCount}\n\n脚本未等待或核验后台上架结果。`);
                    return;
                }
            }
            setStatus(`已停止：已点击确认 ${submittedCount}，跳过 ${failedCount}`, 'error');
        } catch (error) {
            console.error('[自动上架] 任务中止：', error);
            setStatus(`任务中止：${error.message}`, 'error');
            alert(`自动上架任务中止：${error.message}`);
        } finally {
            running = false;
            document.querySelector('#haoka-auto-start').disabled = false;
            document.querySelector('#haoka-auto-stop').disabled = true;
        }
    }

    function stop() {
        if (!running) return;
        stopRequested = true;
        setStatus('正在安全停止，请稍候…', 'error');
    }

    function createPanel() {
        if (document.querySelector('#haoka-auto-panel')) return;
        const panel = document.createElement('div');
        panel.id = 'haoka-auto-panel';
        panel.innerHTML = `
            <div style="font-weight:700;margin-bottom:8px">商品自动上架</div>
            <div id="haoka-auto-status" style="font-size:12px;margin-bottom:6px">就绪，请手动开始</div>
            <div id="haoka-auto-stats" style="font-size:12px;color:#ddd;margin-bottom:9px">已点击确认 0 ｜跳过 0 ｜第 ${getCurrentPage()} 页</div>
            <button id="haoka-auto-start">开始全部上架</button>
            <button id="haoka-auto-stop" disabled>停止</button>
        `;
        Object.assign(panel.style, {
            position: 'fixed', right: '18px', top: '18px', bottom: 'auto', left: 'auto',
            height: 'auto', minHeight: '0', maxHeight: '180px', zIndex: '2147483647',
            width: '230px', padding: '13px', color: '#fff', background: 'rgba(25,28,35,.94)',
            border: '1px solid #31BDEC', borderRadius: '8px', boxShadow: '0 4px 18px rgba(0,0,0,.35)',
            fontFamily: 'Arial,"Microsoft YaHei",sans-serif'
        });
        panel.querySelectorAll('button').forEach(btn => Object.assign(btn.style, {
            padding: '6px 10px', marginRight: '6px', border: '0', borderRadius: '4px', cursor: 'pointer'
        }));
        document.body.appendChild(panel);
        panel.querySelector('#haoka-auto-start').addEventListener('click', run);
        panel.querySelector('#haoka-auto-stop').addEventListener('click', stop);
    }

    // -------------------- 代理商自动激活 --------------------
    let agentRunning = false;
    let agentStopRequested = false;
    let agentSuccessCount = 0;
    let agentFailedCount = 0;
    const agentAttempts = new Map();

    function getActivateButtons() {
        return [...document.querySelectorAll('button[lay-event="act"]')]
            .filter(btn => text(btn) === '激活' && btn.offsetParent !== null);
    }

    function getAgentAccount(button) {
        const row = button.closest('tr');
        return text(row?.querySelector('td')) || text(row).slice(0, 80) || '未知代理';
    }

    function setAgentStatus(message, kind = 'normal') {
        const status = document.querySelector('#haoka-agent-status');
        if (!status) return;
        status.textContent = message;
        status.style.color = kind === 'error' ? '#ffb4b4' : kind === 'done' ? '#9dffb0' : '#fff';
    }

    function updateAgentStats() {
        const stats = document.querySelector('#haoka-agent-stats');
        if (stats) {
            stats.textContent = `成功 ${agentSuccessCount} ｜失败 ${agentFailedCount} ｜第 ${getCurrentPage()} 页`;
        }
    }

    async function waitForAgentTableReady(timeout = CONFIG.pageTimeout) {
        const oldStop = stopRequested;
        stopRequested = agentStopRequested;
        try {
            await waitForTableReady(timeout);
        } finally {
            stopRequested = oldStop;
        }
        if (agentStopRequested) throw new Error('用户已停止');
    }

    async function activateOne(button) {
        const account = getAgentAccount(button);
        agentAttempts.set(account, (agentAttempts.get(account) || 0) + 1);
        setAgentStatus(`正在激活代理 ${account}…`);

        button.click();
        const confirmButton = await waitFor(() => {
            const dialog = [...document.querySelectorAll('.layui-layer-dialog')]
                .find(el => text(el).includes('确定要激活吗'));
            return dialog?.querySelector('.layui-layer-btn0');
        });
        confirmButton.click();

        await waitFor(() => {
            const dialogGone = ![...document.querySelectorAll('.layui-layer-dialog')]
                .some(el => text(el).includes('确定要激活吗'));
            return dialogGone && (!button.isConnected || text(button) !== '激活');
        });

        agentSuccessCount++;
        agentAttempts.delete(account);
        updateAgentStats();
        await waitForAgentTableReady();
    }

    async function processCurrentAgentPage() {
        let consecutiveEmptyChecks = 0;
        while (!agentStopRequested) {
            const button = getActivateButtons().find(btn => {
                const account = getAgentAccount(btn);
                return (agentAttempts.get(account) || 0) < CONFIG.maxRetriesPerProduct;
            });

            if (!button) {
                consecutiveEmptyChecks++;
                if (consecutiveEmptyChecks >= 3) return;
                await waitForAgentTableReady();
                continue;
            }
            consecutiveEmptyChecks = 0;

            const account = getAgentAccount(button);
            try {
                await activateOne(button);
            } catch (error) {
                if (agentStopRequested) throw error;
                console.warn(`[代理自动激活] ${account} 本次操作失败：`, error);
                if ((agentAttempts.get(account) || 0) >= CONFIG.maxRetriesPerProduct) {
                    agentFailedCount++;
                    setAgentStatus(`代理 ${account} 连续失败，已跳过`, 'error');
                } else {
                    setAgentStatus(`代理 ${account} 激活失败，准备重试…`, 'error');
                }
                updateAgentStats();
                document.querySelector('.layui-layer-dialog .layui-layer-close')?.click();
                await sleep(1000);
            }
        }
    }

    async function goNextAgentPage() {
        await waitForAgentTableReady();
        const next = document.querySelector('.layui-laypage-next:not(.layui-disabled)');
        if (!next) return false;
        const oldPage = getCurrentPage();
        const oldFirstRow = text(document.querySelector('.layui-table-body tbody tr'));
        next.click();
        await waitFor(() => getCurrentPage() !== oldPage ||
            text(document.querySelector('.layui-table-body tbody tr')) !== oldFirstRow, CONFIG.pageTimeout);
        await waitForAgentTableReady();
        return true;
    }

    async function runAgentActivation() {
        if (agentRunning) return;
        if (!window.confirm('将切换为每页 20 条，从第 1 页开始遍历全部代理商，并自动确认所有“激活”操作。\n\n确定开始吗？')) return;

        agentRunning = true;
        agentStopRequested = false;
        agentSuccessCount = 0;
        agentFailedCount = 0;
        agentAttempts.clear();
        document.querySelector('#haoka-agent-start').disabled = true;
        document.querySelector('#haoka-agent-stop').disabled = false;

        try {
            setAgentStatus('正在切换为 20 条/页并返回第 1 页…');
            await changePageSize(CONFIG.agentPageSize);
            await jumpToFirstPage();

            while (!agentStopRequested) {
                updateAgentStats();
                setAgentStatus(`正在检查第 ${getCurrentPage()} 页…`);
                await processCurrentAgentPage();
                if (agentStopRequested) break;
                if (!(await goNextAgentPage())) {
                    setAgentStatus(`全部完成：成功 ${agentSuccessCount}，失败 ${agentFailedCount}`,
                        agentFailedCount ? 'error' : 'done');
                    alert(`代理自动激活完成！\n成功：${agentSuccessCount}\n失败：${agentFailedCount}`);
                    return;
                }
            }
            setAgentStatus(`已停止：成功 ${agentSuccessCount}，失败 ${agentFailedCount}`, 'error');
        } catch (error) {
            console.error('[代理自动激活] 任务中止：', error);
            setAgentStatus(`任务中止：${error.message}`, 'error');
            alert(`代理自动激活任务中止：${error.message}`);
        } finally {
            agentRunning = false;
            document.querySelector('#haoka-agent-start').disabled = false;
            document.querySelector('#haoka-agent-stop').disabled = true;
        }
    }

    function createAgentPanel() {
        if (document.querySelector('#haoka-agent-panel')) return;
        const panel = document.createElement('div');
        panel.id = 'haoka-agent-panel';
        panel.innerHTML = `
            <div style="font-weight:700;margin-bottom:8px">代理商自动激活</div>
            <div id="haoka-agent-status" style="font-size:12px;margin-bottom:6px">就绪，请手动开始</div>
            <div id="haoka-agent-stats" style="font-size:12px;color:#ddd;margin-bottom:9px">成功 0 ｜失败 0 ｜第 ${getCurrentPage()} 页</div>
            <button id="haoka-agent-start">开始遍历激活</button>
            <button id="haoka-agent-stop" disabled>停止</button>
        `;
        Object.assign(panel.style, {
            position: 'fixed', right: '18px', top: '18px', bottom: 'auto', left: 'auto',
            height: 'auto', minHeight: '0', maxHeight: '180px', zIndex: '2147483647',
            width: '240px', padding: '13px', color: '#fff', background: 'rgba(25,28,35,.94)',
            border: '1px solid #9c7cff', borderRadius: '8px', boxShadow: '0 4px 18px rgba(0,0,0,.35)',
            fontFamily: 'Arial,"Microsoft YaHei",sans-serif'
        });
        panel.querySelectorAll('button').forEach(btn => Object.assign(btn.style, {
            padding: '6px 10px', marginRight: '6px', border: '0', borderRadius: '4px', cursor: 'pointer'
        }));
        document.body.appendChild(panel);
        panel.querySelector('#haoka-agent-start').addEventListener('click', runAgentActivation);
        panel.querySelector('#haoka-agent-stop').addEventListener('click', () => {
            if (!agentRunning) return;
            agentStopRequested = true;
            setAgentStatus('正在安全停止，请稍候…', 'error');
        });
    }

    // 只在真正包含商品表格和 Layui 分页器的页面/iframe 中显示控制面板。
    const detectTimer = setInterval(() => {
        const hasProductTable = document.querySelector('.layui-table-body');
        const hasPager = document.querySelector('.layui-laypage');
        const hasProductAction = [...document.querySelectorAll('button[lay-event]')]
            .some(btn => ['上架', '下架'].includes(text(btn)));
        if (hasProductTable && hasPager && hasProductAction) {
            clearInterval(detectTimer);
            createPanel();
            return;
        }

        const isAgentList = [...document.querySelectorAll('h1,h2,h3,.layui-breadcrumb')]
            .some(el => text(el).includes('代理商列表'));
        if (hasProductTable && hasPager && isAgentList) {
            clearInterval(detectTimer);
            createAgentPanel();
        }
    }, 800);

    setTimeout(() => clearInterval(detectTimer), 60000);
})();
