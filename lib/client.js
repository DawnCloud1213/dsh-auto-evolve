/**
 * @dawn/dsh-auto-evolve — 客户端插件(client.js)
 *
 * 浏览器端 bundle(window.__ModuleLoader__.load 格式,零构建依赖)。
 * 职责:在会话页 conversation.view 注册 "进化" 视图 Tab,展示:
 *   1) 概况条 —— 技能数/活跃数、累计触发次数、路线事件、待审队列
 *   2) 审查心跳 —— 插件版本、累计工具调用、触发阈值、最近一次审查结论
 *   3) 技能触发次数榜 —— 按 useCount 降序的条形榜,点击查看技能正文
 *   4) 进化路线时间线 —— 账本事件(草稿/改写/转正/退役),带原因与置信度
 * 数据通过 fetch 调用 host 的 /api/evolve-dashboard/* 路由获取,纯只读。
 */

window.__ModuleLoader__.load({
  id: '@dawn/dsh-auto-evolve',
  factory: function (require) {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    var React = require('react');
    var el = React.createElement;

    var API = '/api/evolve-dashboard/';
    var REFRESH_MS = 8000;
    var TIMELINE_LIMIT = 200;

    // ---------- RPC(fetch 调 host HTTP 路由) ----------

    function rpc(method, args) {
      return fetch(API + method, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(args || {}),
      }).then(function (r) {
        if (!r.ok) {
          return r.text().then(function (t) {
            var msg = '进化接口不可用 (HTTP ' + r.status + (t ? ': ' + t.slice(0, 120) : '') + ')';
            if (r.status === 404) msg += ' — 请确认 @dawn/dsh-auto-evolve 已启用并重启 DSH';
            throw new Error(msg);
          });
        }
        return r.json();
      });
    }

    // ---------- 格式化 ----------

    function pad2(n) { return n < 10 ? '0' + n : String(n); }

    function fmtDateTime(iso) {
      if (!iso) return '—';
      var d = new Date(iso);
      if (isNaN(d.getTime())) return '—';
      return pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
    }

    function fmtRel(iso) {
      if (!iso) return '—';
      var d = new Date(iso);
      if (isNaN(d.getTime())) return '—';
      var diff = (Date.now() - d.getTime()) / 1000;
      if (diff < 0) diff = 0;
      if (diff < 60) return '刚刚';
      if (diff < 3600) return Math.floor(diff / 60) + ' 分钟前';
      if (diff < 86400) return Math.floor(diff / 3600) + ' 小时前';
      if (diff < 86400 * 30) return Math.floor(diff / 86400) + ' 天前';
      return fmtDateTime(iso);
    }

    function fmtNum(n) {
      var v = Number(n) || 0;
      if (v >= 10000) return (v / 10000).toFixed(1) + 'w';
      return String(v);
    }

    function tinySession(sid) {
      var s = String(sid || '');
      return s.length > 10 ? s.slice(0, 8) + '…' : s;
    }

    // ---------- 语义映射 ----------

    var STATE_LABEL = { active: '活跃', draft: '草稿', retired: '退役', archived: '归档', stale: '陈旧' };
    var STATE_TONE = { active: 'ok', draft: 'warn', retired: 'muted', archived: 'muted', stale: 'warn' };

    var ACTION_LABEL = {
      draft: '草稿', patch: '改写', promote: '转正', retire: '退役',
      refuse: '拒绝', reject: '拒收', skip: '跳过', skipped: '跳过', skip_low_confidence: '低置信跳过',
    };
    var ACTION_TONE = {
      draft: 'warn', patch: 'brand', promote: 'ok', retire: 'muted',
      refuse: 'err', reject: 'err', skip: 'muted', skipped: 'muted',
    };

    var CREATED_BY_LABEL = { agent: '自沉淀', external: '外部', user: '用户', imported: '导入' };

    function stateLabel(s) { return STATE_LABEL[s] || s || '未知'; }
    function stateTone(s) { return STATE_TONE[s] || 'muted'; }
    function actionLabel(a) { return ACTION_LABEL[a] || a || '事件'; }
    function actionTone(a) { return ACTION_TONE[a] || 'muted'; }
    function createdByLabel(c) { return CREATED_BY_LABEL[c] || c || '—'; }

    // ---------- 样式注入 ----------

    function injectStyle(css) {
      var tag = document.createElement('style');
      tag.setAttribute('data-plugin-css', '@dawn/dsh-auto-evolve');
      tag.textContent = css;
      document.head.appendChild(tag);
      return function () { tag.remove(); };
    }

    var EV_CSS = [
      '.ev-root { display: flex; flex-direction: column; height: 100%; min-height: 0; overflow: hidden;',
      '  color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-base); }',
      '.ev-topbar { display: flex; align-items: center; gap: 10px; padding: 10px 14px 8px; flex: 0 0 auto; }',
      '.ev-title { font-size: 14px; font-weight: 600; letter-spacing: .2px; }',
      '.ev-title-sub { font-size: 12px; color: var(--dsw-alias-label-tertiary); }',
      '.ev-spacer { flex: 1 1 auto; }',
      '.ev-btn { font-size: 12px; padding: 3px 10px; border-radius: 6px; cursor: pointer;',
      '  border: 1px solid var(--dsw-alias-label-tertiary); background: transparent; color: var(--dsw-alias-label-primary); }',
      '.ev-btn:hover { background: var(--dsw-alias-bg-layer-1); }',
      '.ev-btn:disabled { opacity: .5; cursor: default; }',
      '.ev-cards { display: flex; gap: 10px; padding: 0 14px 8px; flex: 0 0 auto; flex-wrap: wrap; }',
      '.ev-card { flex: 1 1 150px; min-width: 130px; border-radius: 8px; padding: 8px 12px;',
      '  background: var(--dsw-alias-bg-layer-1); border: 1px solid rgba(127,127,127,.14); }',
      '.ev-card-label { font-size: 11px; color: var(--dsw-alias-label-tertiary); margin-bottom: 2px; }',
      '.ev-card-value { font-size: 20px; font-weight: 650; line-height: 1.15; font-variant-numeric: tabular-nums; }',
      '.ev-card-sub { font-size: 11px; color: var(--dsw-alias-label-secondary); margin-top: 2px; }',
      '.ev-heartbeat { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 0 14px 8px;',
      '  font-size: 11px; color: var(--dsw-alias-label-tertiary); flex: 0 0 auto; }',
      '.ev-heartbeat .ev-dot-ok { width: 6px; height: 6px; border-radius: 50%; background: var(--dsw-alias-state-success-primary); }',
      '.ev-heartbeat .ev-dot-warn { width: 6px; height: 6px; border-radius: 50%; background: var(--dsw-alias-state-warn-primary); }',
      '.ev-heartbeat-sep { color: var(--dsw-alias-label-tertiary); opacity: .5; }',
      '.ev-body { flex: 1 1 auto; min-height: 0; display: flex; gap: 10px; padding: 0 14px 12px; overflow: hidden; }',
      '.ev-panel { flex: 1 1 50%; min-width: 0; display: flex; flex-direction: column; border-radius: 10px;',
      '  background: var(--dsw-alias-bg-layer-1); border: 1px solid rgba(127,127,127,.14); overflow: hidden; }',
      '.ev-panel-head { display: flex; align-items: center; gap: 8px; padding: 8px 12px; flex: 0 0 auto;',
      '  border-bottom: 1px solid rgba(127,127,127,.12); }',
      '.ev-panel-title { font-size: 12px; font-weight: 600; }',
      '.ev-panel-count { font-size: 11px; color: var(--dsw-alias-label-tertiary); }',
      '.ev-scroll { flex: 1 1 auto; overflow: auto; min-height: 0; }',
      '.ev-row { display: flex; align-items: center; gap: 8px; padding: 5px 12px; cursor: pointer; font-size: 12px; }',
      '.ev-row:hover { background: var(--dsw-alias-bg-base); }',
      '.ev-rank { width: 20px; text-align: right; font-size: 11px; color: var(--dsw-alias-label-tertiary); font-variant-numeric: tabular-nums; }',
      '.ev-slug { width: 40%; max-width: 240px; min-width: 90px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
      '.ev-bar-wrap { flex: 1 1 auto; height: 6px; border-radius: 3px; background: rgba(127,127,127,.14); overflow: hidden; }',
      '.ev-bar { height: 100%; border-radius: 3px; background: var(--dsw-alias-brand-primary); }',
      '.ev-bar-zero { height: 100%; width: 2px; opacity: .3; background: var(--dsw-alias-label-tertiary); }',
      '.ev-count { width: 42px; text-align: right; font-variant-numeric: tabular-nums; font-weight: 600; }',
      '.ev-badge { font-size: 10px; line-height: 1; padding: 3px 6px; border-radius: 999px; white-space: nowrap;',
      '  color: var(--dsw-alias-label-primary-foreground); }',
      '.ev-badge.ok { background: var(--dsw-alias-state-success-primary); }',
      '.ev-badge.warn { background: var(--dsw-alias-state-warn-primary); }',
      '.ev-badge.err { background: var(--dsw-alias-state-error-primary); }',
      '.ev-badge.brand { background: var(--dsw-alias-button-primary-fill); }',
      '.ev-badge.muted { background: rgba(127,127,127,.35); color: var(--dsw-alias-label-primary); }',
      '.ev-tl-item { display: flex; gap: 9px; padding: 7px 12px 7px 10px; position: relative; }',
      '.ev-tl-item + .ev-tl-item { border-top: 1px solid rgba(127,127,127,.08); }',
      '.ev-tl-rail { flex: 0 0 10px; display: flex; justify-content: center; padding-top: 4px; }',
      '.ev-tl-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--dsw-alias-label-tertiary); }',
      '.ev-tl-body { flex: 1 1 auto; min-width: 0; }',
      '.ev-tl-head { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }',
      '.ev-tl-skill { font-size: 12px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 60%; }',
      '.ev-tl-time { margin-left: auto; font-size: 10.5px; color: var(--dsw-alias-label-tertiary); white-space: nowrap; }',
      '.ev-tl-reason { font-size: 11.5px; color: var(--dsw-alias-label-secondary); margin-top: 2px; line-height: 1.5; word-break: break-word; }',
      '.ev-tl-meta { font-size: 10.5px; color: var(--dsw-alias-label-tertiary); margin-top: 2px; }',
      '.ev-empty { padding: 26px 12px; text-align: center; font-size: 12px; color: var(--dsw-alias-label-tertiary); }',
      '.ev-error { margin: 14px; padding: 12px 14px; border-radius: 8px; font-size: 12px; line-height: 1.6;',
      '  background: rgba(220,60,60,.08); border: 1px solid var(--dsw-alias-state-error-primary); color: var(--dsw-alias-label-primary); }',
      '.ev-error b { color: var(--dsw-alias-state-error-primary); }',
      '.ev-loading { padding: 30px; text-align: center; font-size: 12px; color: var(--dsw-alias-label-tertiary); }',
      '.ev-drawer-mask { position: fixed; inset: 0; background: rgba(0,0,0,.28); z-index: 60; }',
      '.ev-drawer { position: fixed; top: 0; bottom: 0; right: 0; width: min(560px, 88vw); z-index: 61;',
      '  display: flex; flex-direction: column; background: var(--dsw-alias-bg-layer-1);',
      '  box-shadow: -6px 0 24px rgba(0,0,0,.22); border-left: 1px solid rgba(127,127,127,.18); }',
      '.ev-drawer-head { display: flex; align-items: center; gap: 8px; padding: 12px 14px; flex: 0 0 auto;',
      '  border-bottom: 1px solid rgba(127,127,127,.12); }',
      '.ev-drawer-title { font-size: 13px; font-weight: 650; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
      '.ev-drawer-meta { font-size: 11px; color: var(--dsw-alias-label-tertiary); padding: 6px 14px 0; flex: 0 0 auto; }',
      '.ev-drawer-body { flex: 1 1 auto; overflow: auto; padding: 10px 14px 18px; }',
      '.ev-md { margin: 0; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 11.5px;',
      '  line-height: 1.65; white-space: pre-wrap; word-break: break-word; color: var(--dsw-alias-label-secondary);',
      '  background: var(--dsw-alias-bg-base); border-radius: 8px; padding: 10px 12px; }',
      '.ev-close { margin-left: auto; font-size: 16px; line-height: 1; cursor: pointer; border: 0; background: transparent;',
      '  color: var(--dsw-alias-label-tertiary); padding: 2px 6px; border-radius: 6px; }',
      '.ev-close:hover { background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); }',
      '@media (max-width: 900px) { .ev-body { flex-direction: column; } .ev-panel { flex: 1 1 auto; } }',
      // ---- 设置卡片（settings.plugin.item） ----
      '.ev-mini-card { padding: 12px 14px; border-radius: 10px; border: 1px solid rgba(127,127,127,.18);',
      '  background: var(--dsw-alias-bg-layer-1); margin: 8px 0; }',
      '.ev-mini-title { font-size: 13px; font-weight: 600; color: var(--dsw-alias-label-primary); }',
      '.ev-mini-desc { font-size: 11.5px; line-height: 1.6; color: var(--dsw-alias-label-secondary); margin-top: 4px; }',
      '.ev-mini-row { display: flex; align-items: center; gap: 10px; margin-top: 10px; flex-wrap: wrap; }',
      '.ev-mini-label { font-size: 12px; color: var(--dsw-alias-label-primary); }',
      '.ev-mini-select { font-size: 12px; padding: 4px 8px; border-radius: 6px; background: var(--dsw-alias-bg-base);',
      '  color: var(--dsw-alias-label-primary); border: 1px solid rgba(127,127,127,.28); }',
      '.ev-mini-status { font-size: 11px; color: var(--dsw-alias-label-tertiary); }',
      '.ev-mini-error { font-size: 11px; color: var(--dsw-alias-state-error-primary); }',
    ].join('\n');

    // ---------- 基础组件 ----------

    function Badge(props) {
      return el('span', { className: 'ev-badge ' + (props.tone || 'muted') }, props.text);
    }

    function StatCard(props) {
      return el('div', { className: 'ev-card' },
        el('div', { className: 'ev-card-label' }, props.label),
        el('div', { className: 'ev-card-value' }, props.value),
        props.sub ? el('div', { className: 'ev-card-sub' }, props.sub) : null);
    }

    function Empty(props) {
      return el('div', { className: 'ev-empty' }, props.text || '暂无数据');
    }

    // ---------- 技能榜 ----------

    function SkillsBoard(props) {
      var skills = props.skills || [];
      if (!skills.length) {
        return el('div', { className: 'ev-panel' },
          el('div', { className: 'ev-panel-head' },
            el('span', { className: 'ev-panel-title' }, '技能触发次数'),
            el('span', { className: 'ev-panel-count' }, '0 项')),
          Empty({ text: '还没有技能使用记录（遥测从 v0.3.1 才开始计数）' }));
      }
      var max = 1;
      skills.forEach(function (s) { if (s.useCount > max) max = s.useCount; });
      var total = 0;
      skills.forEach(function (s) { total += s.useCount; });

      var rows = skills.map(function (s, i) {
        var pct = s.useCount > 0 ? Math.max(2, Math.round((s.useCount / max) * 100)) : 0;
        var tone = stateTone(s.state);
        return el('div', {
          className: 'ev-row',
          key: s.slug,
          title: s.slug + (s.title && s.title !== s.slug ? ' — ' + s.title : ''),
          onClick: function () { props.onOpenSkill(s.slug); },
        },
          el('span', { className: 'ev-rank' }, String(i + 1)),
          el('span', { className: 'ev-slug' }, s.slug),
          el('span', { className: 'ev-bar-wrap' },
            pct > 0 ? el('span', { className: 'ev-bar', style: { width: pct + '%' } }) : el('span', { className: 'ev-bar-zero' })),
          el('span', { className: 'ev-count' }, fmtNum(s.useCount)),
          el('span', { className: 'ev-badge ' + tone }, stateLabel(s.state)),
          s.file && s.file.promoted ? el('span', { className: 'ev-badge brand' }, '已转正') : null);
      });

      return el('div', { className: 'ev-panel' },
        el('div', { className: 'ev-panel-head' },
          el('span', { className: 'ev-panel-title' }, '技能触发次数'),
          el('span', { className: 'ev-panel-count' }, skills.length + ' 项 · 合计 ' + fmtNum(total) + ' 次')),
        el('div', { className: 'ev-scroll' }, rows));
    }

    // ---------- 时间线 ----------

    function Timeline(props) {
      var entries = props.entries || [];
      if (!entries.length) {
        return el('div', { className: 'ev-panel' },
          el('div', { className: 'ev-panel-head' },
            el('span', { className: 'ev-panel-title' }, '进化路线'),
            el('span', { className: 'ev-panel-count' }, '0 条')),
          Empty({ text: '账本还是空的：审查产出草稿/转正后会写进 ledger.jsonl' }));
      }
      var items = entries.map(function (e, i) {
        var tone = actionTone(e.action);
        var meta = [];
        if (typeof e.confidence === 'number') meta.push('置信度 ' + e.confidence.toFixed(2));
        if (e.model) meta.push(e.model);
        if (e.session) meta.push('会话 ' + tinySession(e.session));
        return el('div', { className: 'ev-tl-item', key: (e.id || 'e') + i },
          el('div', { className: 'ev-tl-rail' },
            el('span', { className: 'ev-tl-dot', style: { background: 'var(' + toneVar(tone) + ')' } })),
          el('div', { className: 'ev-tl-body' },
            el('div', { className: 'ev-tl-head' },
              el('span', { className: 'ev-badge ' + tone }, actionLabel(e.action)),
              el('span', { className: 'ev-tl-skill' }, e.skill || '(未知技能)'),
              el('span', { className: 'ev-tl-time', title: e.ts || '' }, fmtRel(e.ts))),
            e.reason ? el('div', { className: 'ev-tl-reason' }, e.reason) : null,
            meta.length ? el('div', { className: 'ev-tl-meta' }, meta.join(' · ')) : null));
      });
      return el('div', { className: 'ev-panel' },
        el('div', { className: 'ev-panel-head' },
          el('span', { className: 'ev-panel-title' }, '进化路线'),
          el('span', { className: 'ev-panel-count' }, entries.length + ' 条 · 最新在前')),
        el('div', { className: 'ev-scroll' }, items));
    }

    function toneVar(tone) {
      if (tone === 'ok') return '--dsw-alias-state-success-primary';
      if (tone === 'warn') return '--dsw-alias-state-warn-primary';
      if (tone === 'err') return '--dsw-alias-state-error-primary';
      if (tone === 'brand') return '--dsw-alias-brand-primary';
      return '--dsw-alias-label-tertiary';
    }

    // ---------- 抽屉 ----------

    function DetailDrawer(props) {
      if (!props.detail) return null;
      var d = props.detail;
      var keys = [];
      if (d.usage) {
        keys.push('触发 ' + d.usage.useCount + ' 次');
        keys.push('查看 ' + d.usage.viewCount + ' 次');
        if (d.usage.patchCount) keys.push('改写 ' + d.usage.patchCount + ' 次');
        if (d.usage.createdBy) keys.push(createdByLabel(d.usage.createdBy));
        if (d.usage.lastUsedAt) keys.push('最近使用 ' + fmtRel(d.usage.lastUsedAt));
      }
      var body;
      if (d.loading) body = el('div', { className: 'ev-loading' }, '读取中…');
      else if (d.error) body = el('div', { className: 'ev-error' }, d.error);
      else if (!d.markdown) body = Empty({ text: '这个技能还没有落盘的正文（只在 skill-usage.json 里有使用记录）' });
      else body = el('pre', { className: 'ev-md' }, d.markdown);

      return el('div', null,
        el('div', { className: 'ev-drawer-mask', onClick: props.onClose }),
        el('div', { className: 'ev-drawer' },
          el('div', { className: 'ev-drawer-head' },
            el('span', { className: 'ev-drawer-title' }, d.slug),
            d.source ? el('span', { className: 'ev-badge muted' }, d.source) : null,
            el('button', { className: 'ev-close', onClick: props.onClose, title: '关闭 (Esc)' }, '×')),
          keys.length ? el('div', { className: 'ev-drawer-meta' }, keys.join(' · ')) : null,
          el('div', { className: 'ev-drawer-body' }, body)));
    }

    // ---------- 仪表盘(纯函数,便于自测) ----------

    function renderDashboard(opts) {
      var s = opts.state;
      var detail = opts.detail;

      if (s.loading && !s.overview) {
        return el('div', { className: 'ev-root' }, el('div', { className: 'ev-loading' }, '正在读取进化数据…'));
      }
      if (s.error && !s.overview) {
        return el('div', { className: 'ev-root' },
          el('div', { className: 'ev-topbar' },
            el('span', { className: 'ev-title' }, '进化看板'),
            el('span', { className: 'ev-spacer' }),
            el('button', { className: 'ev-btn', onClick: opts.onRefresh }, '重试')),
          el('div', { className: 'ev-error' },
            el('div', null, el('b', null, '进化接口不可用')),
            el('div', { style: { marginTop: '4px' } }, s.error),
            el('div', { style: { marginTop: '6px', color: 'var(--dsw-alias-label-tertiary)' } },
              '排查：确认 @dawn/dsh-auto-evolve 已装进 desktop profile 并重启 DSH。')));
      }

      var ov = s.overview || {};
      var counts = ov.counts || {};
      var hb = ov.heartbeat;
      var review = ov.review || {};
      var sk = s.skills || {};
      var tl = s.timeline || {};
      var skills = sk.skills || [];
      var entries = tl.entries || [];
      var stats = tl.stats || {};
      var last = review.lastResult;

      var heartbeatBits = [];
      if (hb) {
        heartbeatBits.push(el('span', { className: 'ev-dot-ok' }));
        heartbeatBits.push(el('span', null, '自进化 ' + (hb.version || '?') + ' 运行中'));
        if (hb.pid) heartbeatBits.push(el('span', { className: 'ev-heartbeat-sep' }, '·'), el('span', null, 'pid ' + hb.pid));
        heartbeatBits.push(el('span', { className: 'ev-heartbeat-sep' }, '·'), el('span', null, '累计工具调用 ' + fmtNum(hb.itersTotal)));
        if (hb.nudgeInterval) heartbeatBits.push(el('span', { className: 'ev-heartbeat-sep' }, '·'), el('span', null, '每 ' + hb.nudgeInterval + ' 次审查一轮'));
        heartbeatBits.push(el('span', { className: 'ev-heartbeat-sep' }, '·'), el('span', null, '今日已审 ' + (review.dayCount || 0) + ' 次'));
        if (review.lastReviewAt) heartbeatBits.push(el('span', { className: 'ev-heartbeat-sep' }, '·'), el('span', null, '上次审查 ' + fmtRel(review.lastReviewAt)));
      } else {
        heartbeatBits.push(el('span', { className: 'ev-dot-warn' }));
        heartbeatBits.push(el('span', null, '心跳缺失：自进化插件可能没在跑'));
      }
      if (last) {
        heartbeatBits.push(el('span', { className: 'ev-heartbeat-sep' }, '·'));
        heartbeatBits.push(el('span', null, '最近结论：' + (ACTION_LABEL[last.decision] || last.decision || '—')));
      }
      if (hb && hb.lastError) {
        heartbeatBits.push(el('span', { className: 'ev-heartbeat-sep' }, '·'));
        heartbeatBits.push(el('span', { style: { color: 'var(--dsw-alias-state-error-primary)' } }, '最近错误：' + String(hb.lastError).slice(0, 80)));
      }

      return el('div', { className: 'ev-root' },
        el('div', { className: 'ev-topbar' },
          el('span', { className: 'ev-title' }, '进化看板'),
          el('span', { className: 'ev-title-sub' }, ov.exists === false ? '数据目录未找到' : '自进化系统实况'),
          el('span', { className: 'ev-spacer' }),
          el('span', { className: 'ev-title-sub' }, s.updatedAt ? '更新于 ' + fmtDateTime(s.updatedAt.toISOString()) : ''),
          el('button', { className: 'ev-btn', onClick: opts.onRefresh, disabled: s.loading }, s.loading ? '刷新中…' : '刷新')),

        el('div', { className: 'ev-cards' },
          StatCard({
            label: '技能总数', value: fmtNum(counts.skills),
            sub: '活跃 ' + fmtNum(counts.active) + ' · 归档 ' + fmtNum(counts.archived),
          }),
          StatCard({
            label: '累计触发', value: fmtNum(counts.totalUse),
            sub: '已转正 ' + fmtNum(counts.promoted) + ' 个 · 草稿 ' + fmtNum(counts.drafts),
          }),
          StatCard({
            label: '路线事件', value: fmtNum(counts.ledgerEntries),
            sub: '草稿 ' + fmtNum(stats.draft) + ' · 改写 ' + fmtNum(stats.patch) + ' · 转正 ' + fmtNum(stats.promote) + ' · 退役 ' + fmtNum(stats.retire),
          }),
          StatCard({
            label: '待审队列', value: fmtNum(review.queuePending),
            sub: '今日审查 ' + fmtNum(review.dayCount) + ' 次',
          })),

        el('div', { className: 'ev-heartbeat' }, heartbeatBits),

        el('div', { className: 'ev-body' },
          SkillsBoard({ skills: skills, onOpenSkill: opts.onOpenSkill }),
          Timeline({ entries: entries })),

        DetailDrawer({ detail: detail, onClose: opts.onCloseDetail }));
    }

    // ---------- 数据 hook ----------

    function useDashboard() {
      var st = React.useState({ loading: true, error: null, overview: null, skills: null, timeline: null, updatedAt: null });
      var state = st[0];
      var setState = st[1];
      var load = React.useCallback(function () {
        setState(function (prev) { return Object.assign({}, prev, { loading: true, error: null }); });
        Promise.all([
          rpc('overview'),
          rpc('skills'),
          rpc('timeline', { limit: TIMELINE_LIMIT }),
        ]).then(function (arr) {
          setState({ loading: false, error: null, overview: arr[0], skills: arr[1], timeline: arr[2], updatedAt: new Date() });
        }).catch(function (err) {
          setState(function (prev) {
            return Object.assign({}, prev, { loading: false, error: String((err && err.message) || err) });
          });
        });
      }, []);
      React.useEffect(function () {
        load();
        var timer = setInterval(function () {
          if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
          load();
        }, REFRESH_MS);
        return function () { clearInterval(timer); };
      }, [load]);
      return { state: state, load: load };
    }

    // ---------- 视图组件 ----------

    function EvolveDashboardView() {
      var dash = useDashboard();
      var dt = React.useState(null);
      var detail = dt[0];
      var setDetail = dt[1];

      function openSkill(slug) {
        setDetail({ slug: slug, loading: true, markdown: null, source: null, usage: null, error: null });
        rpc('skill', { slug: slug }).then(function (res) {
          if (!res.ok) throw new Error((res.error && res.error.message) || '读取技能正文失败');
          setDetail({ slug: slug, loading: false, markdown: res.markdown, source: res.source, usage: res.usage, error: null });
        }).catch(function (err) {
          setDetail({ slug: slug, loading: false, markdown: null, source: null, usage: null, error: String((err && err.message) || err) });
        });
      }

      React.useEffect(function () {
        function onKey(e) { if (e && e.key === 'Escape') setDetail(null); }
        document.addEventListener('keydown', onKey);
        return function () { document.removeEventListener('keydown', onKey); };
      }, []);

      return renderDashboard({
        state: dash.state,
        detail: detail,
        onRefresh: dash.load,
        onOpenSkill: openSkill,
        onCloseDetail: function () { setDetail(null); },
      });
    }

    // ---------- 设置卡片：审查思考强度（settings.plugin.item） ----------

    var AUTO_EVOLVE_NS = 'auto-evolve';
    var EFFORT_CHOICES = [
      ['off', 'off（不发送思考强度）'],
      ['low', 'low（低）'],
      ['medium', 'medium（中）'],
      ['high', 'high（高，默认）'],
      ['max', 'max（最高）'],
    ];

    /** 订阅一个 settings scope 的快照（React 18 useSyncExternalStore）。 */
    function useScopeSnapshot(scope) {
      var subscribe = React.useCallback(function (cb) { return scope.subscribe(cb); }, [scope]);
      var getSnapshot = React.useCallback(function () { return scope.getSnapshot(); }, [scope]);
      return React.useSyncExternalStore(subscribe, getSnapshot);
    }

    /** 生成绑定到指定 settings scope 的卡片组件。 */
    function makeEffortCard(scope) {
      return function AutoEvolveEffortCard() {
        var snap = useScopeSnapshot(scope);
        var status = snap && snap.status;
        var writable = Boolean(snap && snap.writable);
        var value = (snap && snap.value && snap.value.reviewReasoningEffort) || 'high';
        var onChange = function (event) {
          var next = event.target.value;
          try {
            Promise.resolve(scope.set('reviewReasoningEffort', next)).catch(function () { /* 由快照状态体现 */ });
          } catch (e) { /* 失败不抛给界面 */ }
        };
        var statusText = status === 'ready' ? (writable ? '修改后立即保存' : '只读') : (status === 'unavailable' ? '不可用' : '加载中…');
        return el('div', { className: 'ev-mini-card' },
          el('div', { className: 'ev-mini-title' }, '审查思考强度'),
          el('div', { className: 'ev-mini-desc' },
            '后台审查跟随 DSH 的主提供商与主模型，这里只调思考强度；修改即保存，下一次审查生效。'),
          el('div', { className: 'ev-mini-row' },
            el('span', { className: 'ev-mini-label' }, '思考强度'),
            el('select', {
              className: 'ev-mini-select',
              value: value,
              disabled: !writable || status !== 'ready',
              onChange: onChange,
            }, EFFORT_CHOICES.map(function (c) {
              return el('option', { key: c[0], value: c[0] }, c[1]);
            })),
            el('span', { className: 'ev-mini-status' }, statusText)
          )
        );
      };
    }

    // ---------- 插件主体 ----------

    var inject = ['slots'];

    function apply(ctx) {
      ctx.effect(function () {
        var removeStyle = injectStyle(EV_CSS);
        var stopSlot = ctx.slots.inject('conversation.view', function () {
          return ctx.slots.register(
            { name: 'conversation.view', id: 'evolve-dashboard', order: 6, label: '进化' },
            function () { return el(EvolveDashboardView, null); });
        });
        return function () {
          stopSlot();
          removeStyle();
        };
      }, 'evolve-dashboard: 进化 Tab');

      // 插件配置卡片（可选依赖 settingsScope：没有它只是少这张卡，不影响看板）
      if (typeof ctx.inject === 'function') {
        try {
          ctx.inject(['settingsScope'], function (sctx) {
            var scope = sctx.settingsScope.bind({ namespace: AUTO_EVOLVE_NS });
            var stopCard = ctx.slots.inject('settings.plugin.item', function () {
              return ctx.slots.register(
                { name: 'settings.plugin.item', key: AUTO_EVOLVE_NS, order: 20 },
                makeEffortCard(scope));
            });
            return function () { stopCard(); };
          }, 'evolve: 审查思考强度卡片');
        } catch (e) { /* 设置服务不可用：静默跳过 */ }
      }
    }

    exports.apply = apply;
    exports.inject = inject;
    exports.renderDashboard = renderDashboard; // 供自测
    return module.exports;
  },
});
