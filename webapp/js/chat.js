/**
 * 聊天页逻辑：HTTP 网关直连 cs-chat 云函数（意图识别/路由/FAQ/LLM/转人工）
 * 转人工后轮询人工坐席消息；支持满意度评价与电话随访预约。
 */
(function () {
  var CFG = window.CS_CONFIG;
  var $ = function (id) { return document.getElementById(id); };
  var chatBody = $('chatBody');
  var msgInput = $('msgInput');
  var btnSend = $('btnSend');
  var convStatus = $('convStatus');

  var sessionId = localStorage.getItem('cs_session_id') || ('s_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8));
  localStorage.setItem('cs_session_id', sessionId);
  var lastTs = 0;
  var pollTimer = null;
  var sending = false;
  var rated = false;
  var lastActions = [];

  /* ---------- 云函数调用（网关直连） ---------- */
  function call(action, data, retries) {
    var payload = Object.assign({ action: action, sessionId: sessionId }, data || {});
    return fetch(CFG.gateway + '/cs-chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .catch(function (e) {
        if (!retries) throw e;
        return new Promise(function (resolve) { setTimeout(resolve, 800); }).then(function () {
          return call(action, data, retries - 1);
        });
      });
  }

  /* ---------- 渲染 ---------- */
  function el(tag, cls, text) {
    var d = document.createElement(tag);
    if (cls) d.className = cls;
    if (text !== undefined) d.textContent = text;
    return d;
  }

  var ROLE_VIEW = {
    user: { cls: 'user', icon: '🧑', who: '我' },
    assistant: { cls: 'assistant', icon: '🤖', who: '小智' },
    agent: { cls: 'agent', icon: '👤', who: '人工客服' },
    system: { cls: 'system-msg', icon: '', who: '' },
  };

  function renderMessage(msg) {
    var view = ROLE_VIEW[msg.role] || ROLE_VIEW.assistant;
    var wrap = el('div', 'msg ' + view.cls);
    if (msg.role === 'system') {
      wrap.appendChild(el('div', 'm-bubble', msg.content));
    } else {
      wrap.appendChild(el('div', 'm-avatar', view.icon));
      var box = el('div');
      box.appendChild(el('div', 'm-bubble', msg.content));
      var meta = msg.meta || {};
      if (msg.role === 'assistant' && meta.intent && meta.route && meta.route !== 'welcome') {
        var m = el('div', 'm-meta');
        m.appendChild(el('span', 'tag', '意图：' + intentLabel(meta.intent)));
        if (typeof meta.confidence === 'number') m.appendChild(el('span', 'tag', '置信度 ' + meta.confidence.toFixed(2)));
        m.appendChild(el('span', 'tag route', '已路由 → ' + routeLabel(meta.route)));
        box.appendChild(m);
      }
      wrap.appendChild(box);
    }
    chatBody.appendChild(wrap);
    chatBody.scrollTop = chatBody.scrollHeight;
    if (msg.createdAt) lastTs = Math.max(lastTs, msg.createdAt);
  }

  function intentLabel(i) {
    return ({
      refund: '退款', order_query: '订单查询', tech_support: '技术支持',
      faq: '常见问题', chitchat: '闲聊', escalate: '转人工', welcome: '欢迎',
    })[i] || i || '未识别';
  }
  function routeLabel(r) {
    return ({
      refund: '退款流程', order_query: '订单查询', tech_support: '技术支持',
      faq: 'FAQ 知识库', chitchat: '智能问答', escalate: '人工客服', welcome: '欢迎',
    })[r] || r;
  }

  function renderTyping() {
    var t = el('div', 'msg assistant typing');
    t.id = 'typing';
    t.innerHTML = '<span></span><span></span><span></span>';
    chatBody.appendChild(t);
    chatBody.scrollTop = chatBody.scrollHeight;
  }
  function removeTyping() {
    var t = $('typing');
    if (t) t.remove();
  }

  function setStatus(status) {
    if (status === 'escalated') {
      convStatus.textContent = '人工客服接入中';
      convStatus.className = 'status-chip escalated';
      startPolling();
    } else {
      convStatus.textContent = status === 'resolved' ? '问题已解决' : '智能服务中';
      convStatus.className = 'status-chip';
    }
  }

  function maybeRate() {
    if (rated || $('rateBox')) return;
    var box = el('div', 'rate-box');
    box.id = 'rateBox';
    box.appendChild(el('div', null, '本次服务解决您的问题了吗？欢迎评价 ⭐'));
    var stars = el('div', 'rate-stars');
    var hover = 0;
    for (var i = 1; i <= 5; i++) {
      (function (n) {
        var s = el('span', 'star', '★');
        s.onclick = function () { doRate(n); };
        s.onmouseenter = function () {
          hover = n; paint();
        };
        s.onmouseleave = function () { hover = 0; paint(); };
        stars.appendChild(s);
      })(i);
    }
    function paint() {
      var kids = stars.children;
      for (var j = 0; j < kids.length; j++) kids[j].className = (j + 1) <= hover ? 'star on' : 'star';
    }
    box.appendChild(stars);
    var skip = el('div', 'muted clickable', '暂不评价');
    skip.onclick = function () { box.remove(); };
    box.appendChild(skip);
    chatBody.appendChild(box);
    chatBody.scrollTop = chatBody.scrollHeight;
  }

  function doRate(n) {
    rated = true;
    call('rate', { rating: n })
      .then(function (r) {
        var box = $('rateBox');
        if (box && r && r.ok) {
          box.innerHTML = '';
          box.appendChild(el('div', null, '感谢您的评价！' + '⭐'.repeat(n) + '（' + n + '/5 分）'));
        }
      })
      .catch(function (e) {
        alert('评价提交失败：' + ((e && e.message) || e));
      });
  }

  /* ---------- 转人工轮询 ---------- */
  function startPolling() {
    if (pollTimer) return;
    pollTimer = setInterval(function () {
      call('poll', { since: lastTs }, 0)
        .then(function (r) {
          if (!r || !r.ok) return;
          setStatus(r.status);
          (r.messages || []).forEach(function (m) {
            if (m.createdAt > lastTs) {
              if (m.meta && m.meta.type === 'rating') return; // 自己的评价回显不重复
              renderMessage(m);
              if (m.meta && m.meta.type === 'escalation_resolved') maybeRate();
            }
          });
        })
        .catch(function () {});
    }, 5000);
  }

  /* ---------- 发送 ---------- */
  function send(text) {
    text = (text || '').trim();
    if (!text || sending) return;
    sending = true;
    btnSend.disabled = true;
    renderMessage({ role: 'user', content: text });
    msgInput.value = '';
    renderTyping();
    call('chat', { message: text }, 1)
      .then(function (r) {
        removeTyping();
        if (!r || !r.ok) {
          renderMessage({ role: 'system', content: '⚠️ ' + ((r && r.error) || '服务异常，请稍后重试') });
          return;
        }
        renderMessage({ role: 'assistant', content: r.reply, meta: { intent: r.intent, confidence: r.confidence, route: r.route } });
        lastActions = r.actions || [];
        setStatus(r.conversationStatus || null);
        return call('history', {}, 0).then(function (h) {
          if (h && h.ok) setStatus(h.status);
          if (h && h.status === 'resolved') maybeRate();
          else if (lastActions.indexOf('rate') >= 0 && h && h.status !== 'escalated') maybeRate();
        });
      })
      .catch(function (e) {
        removeTyping();
        renderMessage({ role: 'system', content: '⚠️ 网络异常，请稍后重试（' + ((e && e.message) || e) + '）' });
      })
      .finally(function () {
        sending = false;
        btnSend.disabled = false;
        msgInput.focus();
      });
  }

  /* ---------- 事件绑定 ---------- */
  btnSend.onclick = function () { send(msgInput.value); };
  msgInput.onkeydown = function (e) {
    if (e.key === 'Enter') send(msgInput.value);
  };
  Array.prototype.forEach.call(document.querySelectorAll('.quick-chip[data-text]'), function (chip) {
    chip.onclick = function () { send(chip.getAttribute('data-text')); };
  });

  var callModal = $('callModal');
  $('btnCallRequest').onclick = function () {
    $('callErr').textContent = '';
    callModal.classList.add('show');
  };
  $('callCancel').onclick = function () { callModal.classList.remove('show'); };
  $('callSubmit').onclick = function () {
    var phone = $('callPhone').value.trim();
    if (!/^1[3-9]\d{9}$/.test(phone)) {
      $('callErr').textContent = '请输入正确的 11 位手机号';
      return;
    }
    $('callSubmit').disabled = true;
    call('request_call', { phone: phone })
      .then(function (r) {
        $('callSubmit').disabled = false;
        if (r && r.ok) {
          callModal.classList.remove('show');
          renderMessage({ role: 'system', content: '📞 ' + r.message });
        } else {
          $('callErr').textContent = (r && r.error) || '提交失败';
        }
      })
      .catch(function (e) {
        $('callSubmit').disabled = false;
        $('callErr').textContent = (e && e.message) || '网络异常';
      });
  };

  /* ---------- 启动 ---------- */
  call('start', {}, 2)
    .then(function (r) {
      $('loadingTip') && $('loadingTip').remove();
      if (r && r.ok) {
        setStatus(r.status);
        (r.messages || []).forEach(renderMessage);
        if (r.status === 'resolved') maybeRate();
      } else {
        renderMessage({ role: 'system', content: '⚠️ ' + ((r && r.error) || '初始化失败') });
      }
    })
    .catch(function (e) {
      $('loadingTip') && $('loadingTip').remove();
      renderMessage({ role: 'system', content: '⚠️ 无法连接云服务：' + ((e && e.message) || e) });
    });
})();
