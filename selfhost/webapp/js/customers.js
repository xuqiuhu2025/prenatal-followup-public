(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const { api, esc } = window.CSAdmin;
  const { fields, guessMapping, validateRows } = window.CustomerData;
  let page = 1, loadVersion = 0, workbook, sourceRows = [], mappedRows = [], checked = [], requestId, busy = false, fileVersion = 0;
  const dialog = $('importDialog');
  function error(id, message) { $(id).textContent = message || ''; $(id).hidden = !message; }
  function statsHtml(values) { return values.map(([name, value]) => '<div class="card"><div class="k">' + name + '</div><div class="v">' + value + '</div></div>').join(''); }
  async function load() {
    const version = ++loadVersion;
    error('customerError', '');
    $('customerPrev').disabled = $('customerNext').disabled = true;
    try {
      const r = await api('customer_list', { keyword: $('customerSearch').value.trim(), page });
      if (version !== loadVersion) return;
      if (!r.ok) throw new Error(r.error || '客户列表加载失败');
      $('customerStats').innerHTML = statsHtml([['客户总数', r.summary.total], ['今日新增', r.summary.today], ['已填写公司', r.summary.companies], ['已添加标签', r.summary.tagged]]);
      $('customerCount').textContent = r.total;
      $('customerTbody').innerHTML = r.list.map(c => '<tr><td><div class="customer-identity"><span class="customer-avatar">' + esc(c.name.slice(0, 1)) + '</span><div><strong>' + esc(c.name) + '</strong><small>#' + esc(c.id) + '</small></div></div></td><td><span class="phone-number">' + esc(c.phone) + '</span><small class="cell-sub">' + esc(c.email || '未填写邮箱') + '</small></td><td>' + esc(c.company || '—') + '</td><td>' + (c.tags ? c.tags.split(/[,，、;]/).filter(Boolean).map(t => '<span class="customer-tag">' + esc(t) + '</span>').join(' ') : '<span class="muted">—</span>') + '</td><td class="note-cell" title="' + esc(c.notes) + '">' + esc(c.notes || '—') + '</td><td class="muted nowrap">' + new Date(c.updated_at).toLocaleDateString('zh-CN') + '</td></tr>').join('');
      $('customerEmpty').hidden = r.list.length > 0;
      if (!r.list.length) {
        $('customerEmpty').querySelector('h3').textContent = $('customerSearch').value.trim() ? '没有找到匹配的客户' : '从第一位客户开始';
        $('customerEmpty').querySelector('p').textContent = $('customerSearch').value.trim() ? '试试其他姓名、手机号、公司或标签。' : '上传一份客户表格，将联系人整理到同一个工作空间。';
      }
      $('customerPageInfo').textContent = '共 ' + r.total + ' 位客户 · 第 ' + page + ' / ' + Math.max(1, Math.ceil(r.total / 20)) + ' 页';
      $('customerPrev').disabled = page <= 1;
      $('customerNext').disabled = page * 20 >= r.total;
    } catch (e) { if (version === loadVersion) error('customerError', e.message); }
  }
  window.CustomerUI = { load };
  $('customerSearchForm').onsubmit = e => { e.preventDefault(); page = 1; load(); };
  $('customerPrev').onclick = () => { page--; load(); };
  $('customerNext').onclick = () => { page++; load(); };
  function setStep(step) {
    ['Upload', 'Preview', 'Result'].forEach((name, i) => {
      $('import' + name).hidden = i !== step;
      $('step' + name).classList.toggle('active', i === step);
      $('step' + name).classList.toggle('complete', i < step);
    });
    $('importNext').hidden = step !== 0;
    $('importBack').hidden = $('importConfirm').hidden = step !== 1;
    $('importDone').hidden = step !== 2;
    $('importFootnote').textContent = step === 2 ? '客户信息已安全保存到工作空间。' : '文件仅在浏览器解析，确认后保存客户信息。';
  }
  function open() {
    fileVersion++; workbook = null; sourceRows = []; checked = []; requestId = null;
    $('customerFile').value = ''; $('mappingArea').hidden = true; $('importNext').disabled = true;
    $('duplicateStrategy').value = 'skip'; error('importError', ''); setStep(0); dialog.showModal();
  }
  function close() { if (!busy) { fileVersion++; dialog.close(); } }
  $('openImport').onclick = $('emptyImport').onclick = open;
  $('closeImport').onclick = close;
  dialog.addEventListener('cancel', e => { if (busy) e.preventDefault(); else fileVersion++; });
  $('importDone').onclick = () => { close(); page = 1; load(); };
  $('importBack').onclick = () => { error('importError', ''); setStep(0); };
  $('downloadTemplate').onclick = () => {
    const ws = XLSX.utils.aoa_to_sheet([fields.map(f => f.label), ['张三', '13800138000', 'zhangsan@example.com', '示例公司', '新客户,意向客户', '请删除示例行后填写真实客户信息']]);
    ws['!cols'] = [18, 20, 30, 24, 24, 48].map(wch => ({ wch }));
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, '客户信息'); XLSX.writeFile(wb, '云舟-客户导入模板.xlsx');
  };
  async function readFile(file) {
    if (!file) return;
    const version = ++fileVersion;
    workbook = null; sourceRows = []; $('mappingArea').hidden = true; $('importNext').disabled = true; error('importError', '');
    try {
      if (!/\.(xlsx|xls|csv)$/i.test(file.name)) throw new Error('请选择 Excel（.xlsx / .xls）或 CSV 文件');
      if (file.size > 5 * 1024 * 1024) throw new Error('文件超过 5 MB，请拆分后导入');
      let data = await file.arrayBuffer();
      if (version !== fileVersion || !dialog.open) return;
      const options = { type: 'array', sheetRows: 2002, raw: true, cellFormula: true };
      if (/\.csv$/i.test(file.name)) {
        try { data = new TextDecoder('utf-8', { fatal: true }).decode(data); }
        catch (e) { data = new TextDecoder('gb18030').decode(data); }
        options.type = 'string';
      }
      workbook = XLSX.read(data, options);
      if (!workbook.SheetNames.length) throw new Error('文件里没有工作表');
      $('selectedFileName').textContent = file.name;
      $('sheetSelect').replaceChildren(...workbook.SheetNames.map(name => new Option(name, name)));
      prepareSheet();
    } catch (e) { if (version === fileVersion) error('importError', e.message || '无法读取文件，请检查表格内容'); }
  }
  function prepareSheet() {
    $('importNext').disabled = true; $('mappingArea').hidden = true; error('importError', '');
    try {
      const ws = workbook.Sheets[$('sheetSelect').value];
      const range = XLSX.utils.decode_range(ws['!fullref'] || ws['!ref'] || 'A1');
      if (range.e.c > 99) throw new Error('表格最多支持 100 列，请移除不需要的列');
      if (range.e.r > 2000) throw new Error('工作表超过 2,000 行，请拆分后导入');
      const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: true, blankrows: true, range: 0 });
      if (rows.length < 2) throw new Error('请在第一行填写表头，并至少提供一行客户数据');
      const headers = rows[0].map(String);
      sourceRows = rows.slice(1).map((values, i) => ({ values, row: i + 2 })).filter(r => r.values.some(v => String(v).trim()));
      if (!sourceRows.length) throw new Error('表格没有客户数据');
      const mapping = guessMapping(headers);
      $('mappingGrid').innerHTML = fields.map(f => '<label class="mapping-field"><span>' + f.label + (f.required ? ' <b>*</b>' : '<small>选填</small>') + '</span><select data-field="' + f.key + '"><option value="-1">不导入此字段</option>' + headers.map((h, i) => '<option value="' + i + '"' + (mapping[f.key] === i ? ' selected' : '') + '>' + esc(h || '未命名列 ' + (i + 1)) + '</option>').join('') + '</select></label>').join('');
      $('mappingArea').hidden = false; $('importNext').disabled = false;
    } catch (e) { error('importError', e.message); }
  }
  $('customerFile').onchange = e => readFile(e.target.files[0]);
  $('sheetSelect').onchange = prepareSheet;
  ['dragenter', 'dragover'].forEach(type => $('dropZone').addEventListener(type, e => { e.preventDefault(); $('dropZone').classList.add('dragging'); }));
  ['dragleave', 'drop'].forEach(type => $('dropZone').addEventListener(type, e => { e.preventDefault(); $('dropZone').classList.remove('dragging'); }));
  $('dropZone').addEventListener('drop', e => readFile(e.dataTransfer.files[0]));
  $('importNext').onclick = () => {
    error('importError', '');
    try {
      const mapping = {};
      $('mappingGrid').querySelectorAll('select').forEach(s => { mapping[s.dataset.field] = Number(s.value); });
      if (mapping.name < 0 || mapping.phone < 0) throw new Error('请匹配客户姓名和手机号码两列');
      const selected = Object.values(mapping).filter(n => n >= 0);
      if (new Set(selected).size !== selected.length) throw new Error('同一列不能匹配到多个客户字段');
      mappedRows = sourceRows.map(r => {
        const row = { row: r.row };
        fields.forEach(f => { row[f.key] = mapping[f.key] < 0 ? '' : r.values[mapping[f.key]] ?? ''; });
        return row;
      });
      checked = validateRows(mappedRows);
      const invalid = checked.filter(r => r.errors.length).length;
      const valid = checked.length - invalid;
      $('previewSummary').innerHTML = '<span>共 <b>' + checked.length + '</b> 行</span><span class="valid-count">可导入 <b>' + valid + '</b> 行</span><span class="invalid-count">待修正 <b>' + invalid + '</b> 行</span>';
      $('previewTbody').innerHTML = checked.slice(0, 50).map(r => '<tr><td>' + r.row + '</td><td>' + esc(r.data.name) + '</td><td>' + esc(r.data.phone) + '</td><td>' + (r.errors.length ? '<span class="validation-error">' + esc(r.errors.join('；')) + '</span>' : '<span class="badge resolved">格式正确</span>') + '</td></tr>').join('');
      $('importConfirm').disabled = !valid; $('importConfirm').textContent = '确认导入 ' + valid + ' 行';
      $('downloadErrors').hidden = !invalid;
      requestId = uuid(); setStep(1);
    } catch (e) { error('importError', e.message); }
  };
  function uuid() {
    const b = crypto.getRandomValues(new Uint8Array(16)); b[6] = b[6] & 15 | 64; b[8] = b[8] & 63 | 128;
    const s = Array.from(b, n => n.toString(16).padStart(2, '0')).join('');
    return s.slice(0,8) + '-' + s.slice(8,12) + '-' + s.slice(12,16) + '-' + s.slice(16,20) + '-' + s.slice(20);
  }
  $('duplicateStrategy').onchange = () => { requestId = uuid(); };
  $('downloadErrors').onclick = () => {
    const rows = [['原表行号', '客户姓名', '手机号码', '错误原因']].concat(checked.filter(r => r.errors.length).map(r => [r.row, r.data.name, r.data.phone, r.errors.join('；')]));
    const ws = XLSX.utils.aoa_to_sheet(rows), wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '待修正数据'); XLSX.writeFile(wb, '客户导入-错误明细.xlsx');
  };
  $('importConfirm').onclick = async () => {
    if (busy) return;
    busy = true; error('importError', '');
    ['importConfirm','importBack','closeImport','duplicateStrategy'].forEach(id => { $(id).disabled = true; });
    $('importConfirm').textContent = '正在保存…';
    try {
      const r = await api('customer_import', { rows: mappedRows, strategy: $('duplicateStrategy').value, source: $('selectedFileName').textContent, requestId });
      if (!r.ok) throw new Error(r.error || '导入失败，请重试');
      $('resultSummary').innerHTML = statsHtml([['新增客户', r.inserted], ['更新客户', r.updated], ['已有客户跳过', r.skipped], ['无效行跳过', r.invalid]]);
      setStep(2); page = 1; load();
    } catch (e) { error('importError', e.message + '。可点击重试，同一次导入不会重复写入。'); }
    finally {
      busy = false;
      ['importConfirm','importBack','closeImport','duplicateStrategy'].forEach(id => { $(id).disabled = false; });
      $('importConfirm').textContent = '确认导入';
    }
  };
})();
