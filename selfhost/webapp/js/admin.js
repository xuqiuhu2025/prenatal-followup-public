/**
 * 管理后台逻辑：密码登录 → cs-admin 云函数
 * 看板统计 / 对话记录与人工回复 / 转人工工单 / 电话随访 / FAQ 管理
 */
(function () {
  var CFG = window.CS_CONFIG;
  var $ = function (id) { return document.getElementById(id); };
  var app = null;
  var token = sessionStorage.getItem('cs_admin_token') || '';
  var currentSession = null;

  var INTENT_LABEL = {
    refund: '退款', order_query: '订单查询', tech_support: '技术支持',
    faq: '常见问题', chitchat: '闲聊', escalate: '转人工', unknown: '未识别', welcome: '欢迎',
  };
  var STATUS_LABEL = { open: '服务中', resolved: '已解决', escalated: '转人工', closed: '已关闭' };
  var CALL_LABEL = {
    pending: '排队中', dialing: '拨号中', answered: '已接通', no_answer: '未接听', failed: '失败',
  };
  var ESC_LABEL = { pending: '待处理', handling: '处理中', resolved: '已解决' };

  function fmtTime(ts) {
    if (!ts) return '-';
    var d = new Date(ts);
    function p(n) { return n < 10 ? '0' + n : n; }
    return (d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function api(action, data) {
    return fetch(CFG.gateway + '/cs-admin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({ action: action, token: token }, data || {})),
    })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      });
  }

  /* ---------------- 登录 ---------------- */
  function tryAutoLogin() {
    if (!token) return Promise.resolve(false);
    return api('stats').then(function (r) { return !!(r && r.ok); }).catch(function () { return false; });
  }

  $('btnLogin').onclick = doLogin;
  $('pwdInput').onkeydown = function (e) { if (e.key === 'Enter') doLogin(); };
  function doLogin() {
    var pwd = $('pwdInput').value;
    if (!pwd) return;
    $('pwdErr').textContent = '';
    api('login', { password: pwd, token: '' })
      .then(function (r) {
        if (r && r.ok) {
          token = r.token;
          sessionStorage.setItem('cs_admin_token', token);
          enter();
        } else {
          $('pwdErr').textContent = (r && r.error) || '登录失败';
        }
      })
      .catch(function (e) { $('pwdErr').textContent = (e && e.message) || '网络异常'; });
  }

  function enter() {
    $('loginMask').style.display = 'none';
    $('adminShell').style.display = 'flex';
    switchPage(location.hash === '#customers' ? 'customers' : 'dashboard');
  }

  /* ---------------- 页面切换 ---------------- */
  var pages = { customers: function () { window.CustomerUI.load(); }, dashboard: loadDashboard, conversations: loadConversations, escalations: loadEscalations, calls: loadCalls, faq: loadFaq };
  Array.prototype.forEach.call(document.querySelectorAll('.side nav a'), function (a) {
    a.onclick = function (e) {
      e.preventDefault();
      Array.prototype.forEach.call(document.querySelectorAll('.side nav a'), function (x) { x.classList.remove('active'); });
      a.classList.add('active');
      switchPage(a.getAttribute('data-page'));
    };
  });
  function switchPage(p) {
    Object.keys(pages).forEach(function (k) {
      $('page-' + k).style.display = k === p ? '' : 'none';
    });
    document.querySelectorAll('.side nav a').forEach(function (a) { a.classList.toggle('active', a.dataset.page === p); });
    $('currentPageTitle').textContent = ({ dashboard: '工作概览', customers: '客户管理', conversations: '对话记录', escalations: '人工工单', calls: '电话随访', faq: '知识库' })[p];
    history.replaceState(null, '', '#' + p);
    pages[p]();
  }

  /* ---------------- 看板 ---------------- */
  function loadDashboard() {
    api('stats').then(function (r) {
      if (!r || !r.ok) return alert((r && r.error) || '加载失败');
      var t = r.totals;
      var cards = [
        ['总对话数', t.conversations, ''],
        ['今日新增', t.todayConversations, ''],

        ['平均满意度', t.satisfactionAvg == null ? '—' : t.satisfactionAvg, ' / 5 · ' + t.satisfactionCount + ' 条'],

        ['解决率', (r.rates.resolveRate * 100).toFixed(1) + '%', ''],

      ];
      $('statCards').innerHTML = cards.map(function (c) {
        return '<div class="card"><div class="k">' + c[0] + '</div><div class="v">' + c[1] + '<small> ' + c[2] + '</small></div></div>';
      }).join('');

      // 7 天柱状
      var maxD = Math.max.apply(null, r.daily.map(function (d) { return d.conversations; }).concat([1]));
      $('dailyChart').innerHTML = r.daily.map(function (d) {
        var h = Math.round((d.conversations / maxD) * 100);
        return '<div class="day"><span class="val">' + d.conversations + '</span><div class="col" style="height:' + Math.max(h, 3) + '%"></div><span class="cap">' + d.date + '</span></div>';
      }).join('');

      // 意图分布
      var intents = Object.keys(r.intentDist).map(function (k) { return [INTENT_LABEL[k] || k, r.intentDist[k]]; });
      renderBars('intentChart', intents);
      // 满意度分布
      var ratings = [];
      for (var i = 5; i >= 1; i--) ratings.push([i + ' 星', r.ratingDist[i] || 0]);
      renderBars('ratingChart', ratings);
    });
  }

  function renderBars(id, rows) {
    var max = Math.max.apply(null, rows.map(function (x) { return x[1]; }).concat([1]));
    $(id).innerHTML = rows.map(function (x) {
      return (
        '<div class="chart-row"><span class="lb">' + esc(x[0]) + '</span>' +
        '<div class="bar-wrap"><div class="bar" style="width:' + Math.max(Math.round((x[1] / max) * 100), 1) + '%"></div></div>' +
        '<span class="num">' + x[1] + '</span></div>'
      );
    }).join('') || '<div class="empty-tip">暂无数据</div>';
  }

  /* ---------------- 对话记录 ---------------- */
  $('btnSearch').onclick = function (e) { e.preventDefault(); loadConversations(); };
  $('fKeyword').onkeydown = function (e) { if (e.key === 'Enter') loadConversations(); };

  function loadConversations() {
    api('conversations', {
      status: $('fStatus').value,
      intent: $('fIntent').value,
      keyword: $('fKeyword').value.trim(),
      page: 1,
      pageSize: 30,
    }).then(function (r) {
      if (!r || !r.ok) return;
      var list = r.list || [];
      $('convEmpty').style.display = list.length ? 'none' : '';
      $('convTbody').innerHTML = list.map(function (c) {
        return (
          '<tr class="clickable" onclick="window.__openConv(\'' + c.sessionId + '\')">' +
          '<td class="muted">' + esc(c.sessionId.slice(0, 12)) + '…</td>' +
          '<td><span class="badge ' + c.status + '">' + (STATUS_LABEL[c.status] || c.status) + '</span></td>' +
          '<td>' + (INTENT_LABEL[c.intent] || '—') + '</td>' +
          '<td class="muted" style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(c.lastMessage) + '</td>' +
          '<td>' + (c.rating ? '⭐' + c.rating : '—') + '</td>' +
          '<td class="muted">' + fmtTime(c.updatedAt) + '</td></tr>'
        );
      }).join('');
    });
  }

  window.__openConv = function (sessionId) {
    currentSession = sessionId;
    api('conversation', { sessionId: sessionId }).then(function (r) {
      if (!r || !r.ok) return;
      var c = r.conversation;
      var esc0 = (r.escalations || [])[0];
      var msgs = r.messages || [];
      var timeline = msgs.map(function (m) {
        var who = { user: '用户', assistant: 'AI', agent: '人工', system: '系统' }[m.role] || m.role;
        var meta = '';
        if (m.meta && m.meta.route && m.meta.route !== 'welcome') {
          meta = ' <span class="muted">[' + (INTENT_LABEL[m.meta.intent] || '') + '→' + m.meta.route + ']</span>';
        }
        return '<div class="tl-item ' + m.role + '"><span class="who">' + who + '</span><div class="txt">' + esc(m.content) + meta + '</div></div>';
      }).join('');
      var callInfo = (r.calls || []).map(function (cl) {
        return '<div class="muted">📞 ' + esc(cl.phone) + ' · ' + (CALL_LABEL[cl.status] || cl.status) + ' · ' + fmtTime(cl.processedAt || cl.createdAt) + (cl.result ? ' · ' + esc(cl.result) : '') + '</div>';
      }).join('');
      var rateInfo = (r.ratings || []).map(function (x) { return '<span class="badge resolved">评价 ' + '⭐'.repeat(x.rating) + (x.comment ? ' · ' + esc(x.comment) : '') + '</span>'; }).join(' ');

      $('convDetail').innerHTML =
        '<h3>会话 ' + esc(sessionId) + ' <span class="badge ' + c.status + '">' + (STATUS_LABEL[c.status] || c.status) + '</span> ' + rateInfo + '</h3>' +
        '<div class="muted" style="margin-bottom:10px">用户：' + esc(c.nickname) + ' · 意图：' + (INTENT_LABEL[c.intent] || '—') + (esc0 ? ' · 工单：' + esc(esc0.reason) : '') + '</div>' +
        '<div class="msg-timeline">' + (timeline || '<div class="empty-tip">无消息</div>') + '</div>' +
        callInfo +
        '<div class="reply-box">' +
        '<input id="agentReplyInput" placeholder="以人工坐席身份回复用户…" />' +
        '<button class="btn-sm" onclick="window.__agentReply()">回复</button>' +
        (esc0 && esc0.status !== 'resolved' ? '<button class="btn-sm green" onclick="window.__resolveEsc()">完成工单</button>' : '') +
        '</div>';
      var box = $('convDetail').querySelector('.msg-timeline');
      box.scrollTop = box.scrollHeight;
    });
  };

  window.__agentReply = function () {
    var input = $('agentReplyInput');
    var content = input.value.trim();
    if (!content || !currentSession) return;
    api('agent_reply', { sessionId: currentSession, content: content }).then(function (r) {
      if (r && r.ok) {
        input.value = '';
        window.__openConv(currentSession);
      } else alert((r && r.error) || '发送失败');
    });
  };
  window.__resolveEsc = function () {
    if (!currentSession) return;
    api('escalate_resolve', { sessionId: currentSession }).then(function (r) {
      if (r && r.ok) {
        window.__openConv(currentSession);
        loadConversations();
      } else alert((r && r.error) || '操作失败');
    });
  };

  /* ---------------- 转人工工单 ---------------- */
  function loadEscalations() {
    api('escalations').then(function (r) {
      if (!r || !r.ok) return;
      var list = r.list || [];
      $('escEmpty').style.display = list.length ? 'none' : '';
      $('escTbody').innerHTML = list.map(function (e) {
        return (
          '<tr><td class="muted">' + fmtTime(e.createdAt) + '</td>' +
          '<td class="clickable" onclick="window.__openConvPage(\'' + e.sessionId + '\')">' + esc(e.sessionId.slice(0, 14)) + '…</td>' +
          '<td>' + esc(e.reason) + '</td>' +
          '<td><span class="badge ' + e.status + '">' + (ESC_LABEL[e.status] || e.status) + '</span></td>' +
          '<td><button class="btn-sm" onclick="window.__openConvPage(\'' + e.sessionId + '\')">进入接待</button> ' +
          (e.status !== 'resolved' ? '<button class="btn-sm green" onclick="window.__escResolve(\'' + e.sessionId + '\')">完成</button>' : '') + '</td></tr>'
        );
      }).join('');
    });
  }
  window.__openConvPage = function (sessionId) {
    document.querySelector('.side nav a[data-page="conversations"]').click();
    setTimeout(function () { window.__openConv(sessionId); }, 300);
  };
  window.__escResolve = function (sessionId) {
    api('escalate_resolve', { sessionId: sessionId }).then(function (r) {
      if (r && r.ok) loadEscalations();
      else alert((r && r.error) || '操作失败');
    });
  };

  /* ---------------- 电话随访 ---------------- */
  $('btnNewCall').onclick = function () {
    var phone = $('newCallPhone').value.trim();
    var purpose = $('newCallPurpose').value.trim() || '服务回访';
    if (!/^1[3-9]\d{9}$/.test(phone)) return alert('请输入正确的手机号');
    api('call_create', { phone: phone, purpose: purpose }).then(function (r) {
      if (r && r.ok) {
        $('newCallPhone').value = '';
        $('newCallPurpose').value = '';
        loadCalls();
      } else alert((r && r.error) || '创建失败');
    });
  };
  $('btnProcessAll').onclick = function () {
    var btn = $('btnProcessAll');
    btn.disabled = true;
    btn.textContent = '处理中…';
    // 逐个触发排队任务
    api('calls').then(function (r) {
      var pendings = ((r && r.list) || []).filter(function (c) { return c.status === 'pending'; });
      var chain = Promise.resolve();
      pendings.forEach(function (c) {
        chain = chain.then(function () { return api('call_process', { callId: c.callId }); });
      });
      return chain;
    }).finally(function () {
      btn.disabled = false;
      btn.textContent = '立即处理排队';
      loadCalls();
    });
  };

  function loadCalls() {
    api('calls').then(function (r) {
      if (!r || !r.ok) return;
      var list = r.list || [];
      $('callEmpty').style.display = list.length ? 'none' : '';
      $('callTbody').innerHTML = list.map(function (c) {
        var detail = c.script ? esc(c.script.slice(0, 60)) + (c.script.length > 60 ? '…' : '') : '<span class="muted">待生成话术</span>';
        var op = '';
        if (c.status === 'pending') {
          op = '<button class="btn-sm warn" onclick="window.__callProcess(\'' + c.callId + '\')">立即外呼</button>';
        } else if (c.transcript) {
          op = '<button class="btn-sm gray" onclick="alert(this.getAttribute(\'data-t\'))" data-t="' + esc(c.transcript).replace(/'/g, '&#39;') + '">查看完整记录</button>';
        }
        return (
          '<tr><td class="muted">' + fmtTime(c.createdAt) + '</td><td>' + esc(c.phone) + '</td>' +
          '<td>' + esc(c.purpose) + '</td>' +
          '<td><span class="badge ' + c.status + '">' + (CALL_LABEL[c.status] || c.status) + '</span></td>' +
          '<td class="muted" style="max-width:260px">' + detail + '</td>' +
          '<td>' + op + '</td></tr>'
        );
      }).join('');
    });
  }
  window.__callProcess = function (callId) {
    api('call_process', { callId: callId }).then(function (r) {
      if (r && r.ok) loadCalls();
      else alert((r && r.error) || '处理失败');
    });
  };

  /* ---------------- FAQ ---------------- */
  var editingFaqId = null;
  $('btnNewFaq').onclick = function () {
    editingFaqId = null;
    $('faqModalTitle').textContent = '新增 FAQ';
    $('faqQuestion').value = '';
    $('faqAnswer').value = '';
    $('faqKeywords').value = '';
    $('faqCategory').value = '';
    $('faqErr').textContent = '';
    $('faqModal').classList.add('show');
  };
  $('faqCancel').onclick = function () { $('faqModal').classList.remove('show'); };
  $('faqSave').onclick = function () {
    var q = $('faqQuestion').value.trim();
    var a = $('faqAnswer').value.trim();
    if (!q || !a) { $('faqErr').textContent = '问题和答案不能为空'; return; }
    api('faq_save', {
      id: editingFaqId,
      question: q,
      answer: a,
      keywords: $('faqKeywords').value,
      category: $('faqCategory').value.trim() || '通用',
    }).then(function (r) {
      if (r && r.ok) {
        $('faqModal').classList.remove('show');
        loadFaq();
      } else $('faqErr').textContent = (r && r.error) || '保存失败';
    });
  };

  function loadFaq() {
    api('faq_list').then(function (r) {
      if (!r || !r.ok) return;
      var list = r.list || [];
      $('faqEmpty').style.display = list.length ? 'none' : '';
      $('faqTbody').innerHTML = list.map(function (f) {
        return (
          '<tr><td class="muted">' + esc(f.faqId || '') + '</td><td>' + esc(f.category) + '</td>' +
          '<td style="max-width:180px">' + esc(f.question) + '</td>' +
          '<td class="muted" style="max-width:280px">' + esc(String(f.answer).slice(0, 50)) + '…</td>' +
          '<td class="muted">' + esc((f.keywords || []).join('、')) + '</td>' +
          '<td><button class="btn-sm gray" onclick="window.__faqEdit(\'' + f.id + '\')">编辑</button> ' +
          '<button class="btn-sm gray" style="color:var(--bad)" onclick="window.__faqDelete(\'' + f.id + '\')">删除</button></td></tr>'
        );
      }).join('');
      window.__faqCache = {};
      list.forEach(function (f) { window.__faqCache[f.id] = f; });
    });
  }
  window.__faqEdit = function (id) {
    var f = window.__faqCache[id];
    if (!f) return;
    editingFaqId = id;
    $('faqModalTitle').textContent = '编辑 FAQ';
    $('faqQuestion').value = f.question;
    $('faqAnswer').value = f.answer;
    $('faqKeywords').value = (f.keywords || []).join(',');
    $('faqCategory').value = f.category || '';
    $('faqErr').textContent = '';
    $('faqModal').classList.add('show');
  };
  window.__faqDelete = function (id) {
    if (!confirm('确认删除该 FAQ？')) return;
    api('faq_delete', { id: id }).then(function (r) {
      if (r && r.ok) loadFaq();
      else alert((r && r.error) || '删除失败');
    });
  };

  window.CSAdmin = { api: api, switchPage: switchPage, esc: esc };
  document.querySelectorAll('[data-go]').forEach(function (b) { b.onclick = function () { switchPage(b.dataset.go); }; });
  $('btnLogout').onclick = function () { sessionStorage.removeItem('cs_admin_token'); location.reload(); };
  /* ---------------- 启动 ---------------- */
  document.addEventListener('DOMContentLoaded', function () {
    if (token) {
      tryAutoLogin().then(function (ok) {
        if (ok) enter();
        else $('loginMask').style.display = 'flex';
      });
    } else $('loginMask').style.display = 'flex';
  });
})();
