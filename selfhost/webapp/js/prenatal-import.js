(function () {
  'use strict';
  const cloned=document.getElementById('importDialog').cloneNode(true);cloned.querySelectorAll('[id]').forEach(el=>el.id='pn'+el.id);cloned.id='pnimportDialog';cloned.querySelectorAll('[for]').forEach(el=>el.setAttribute('for','pn'+el.getAttribute('for')));cloned.setAttribute('aria-labelledby','pnimportTitle');document.body.appendChild(cloned);
  const $ = id => document.getElementById('pn'+id);
  const { api, esc } = window.HospitalAdmin;
  const { fields, guessMapping, validateRows } = window.PrenatalData;
  let workbook, sourceRows = [], mappedRows = [], checked = [], requestId, busy = false, fileVersion = 0;
  const dialog = $('importDialog');
  $('importTitle').textContent='导入孕次档案';
  $('importPreview').querySelector('h3').textContent='确认即将导入的孕次';
  $('mappingArea').querySelector('.mapping-tip').textContent='第一行为表头。病案号、孕妇姓名、电话、孕次编号、胎数、随访项目必填。';
  $('importPreview').querySelector('.mapping-tip').textContent='按病案号 + 孕次编号去重。无效行跳过；姓名或电话与已有病案号不一致时须人工核实。展示前50行。';
  $('duplicateStrategy').options[0].textContent='跳过已有孕次';
  $('duplicateStrategy').options[1].textContent='更新孕次，空白资料保留；保留原报告与随访记录';
  $('importPreview').querySelector('label').textContent='发现同一病案号和孕次编号时';
  $('importResult').querySelector('h3').textContent='孕次导入处理完成';
  $('importResult').querySelector('p').textContent='新增与更新数量见下方，无效行请下载明细修正。';
  $('importDone').textContent='查看孕次';
  $('importResult').insertAdjacentHTML('beforeend','<div id="pnresultErrors" hidden><p id="pnresultErrorList" class="notice error"></p><button type="button" class="text-link" id="pnresultDownload">下载未导入行明细</button></div>');
  $('resultDownload').onclick=()=>$('downloadErrors').click();

  function error(id, message) { $(id).textContent = message || ''; $(id).hidden = !message; }
  function statsHtml(values) { return values.map(([name, value]) => '<div class="card"><div class="k">' + name + '</div><div class="v">' + value + '</div></div>').join(''); }
  const load = () => window.PrenatalUI.reload();
  function setStep(step) {
    ['Upload', 'Preview', 'Result'].forEach((name, i) => {
      $('import' + name).hidden = i !== step;
      $('step' + name).classList.toggle('active', i === step);
      $('step' + name).classList.toggle('complete', i < step);
    });
    $('importNext').hidden = step !== 0;
    $('importBack').hidden = $('importConfirm').hidden = step !== 1;
    $('importDone').hidden = step !== 2;
    $('importFootnote').textContent = step === 2 ? '孕次数据处理完成，请检查新增、跳过与无效行。' : '文件仅在浏览器解析，确认后保存孕次信息。';
  }
  function open() {
    fileVersion++; workbook = null; sourceRows = []; checked = []; requestId = null;
    $('customerFile').value = ''; $('mappingArea').hidden = true; $('importNext').disabled = true;
    $('duplicateStrategy').value = 'skip'; error('importError', ''); setStep(0); dialog.showModal();
  }
  function close() { if (!busy) { fileVersion++; dialog.close(); } }
  $('openImport').onclick = open;
  $('closeImport').onclick = close;
  dialog.addEventListener('cancel', e => { if (busy) e.preventDefault(); else fileVersion++; });
  $('importDone').onclick = () => { close(); load(); };
  $('importBack').onclick = () => { error('importError', ''); setStep(0); };
  $('downloadTemplate').onclick = () => {
    const ws = XLSX.utils.aoa_to_sheet([fields.map(f => f.label), fields.map(f=>({patient_no:'DEMO-P001',name:'示例孕妇',phone:'13800138000',birth_date:'1995-01-01',department:'产前诊断中心',clinician:'随访医护',pregnancy_no:'2026-001',lmp:'2026-09-01',edd:'2027-06-08',fetus_count:1,referral_org:'来源医院',projects:'血清学产前筛查,遗传学产前诊断',indications:'请删除示例行后填写；同一孕妇不同孕次分行填写'}[f.key]||''))]);
    ws['!cols'] = [20,18,20,12,18,18,18,18,30,24,48].map(wch => ({ wch }));
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, '孕次信息'); XLSX.writeFile(wb, '安和-产前孕次导入模板.xlsx');
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
      if (rows.length < 2) throw new Error('请在第一行填写表头，并至少提供一行孕次数据');
      const headers = rows[0].map(String);
      sourceRows = rows.slice(1).map((values, i) => ({ values, row: i + 2 })).filter(r => r.values.some(v => String(v).trim()));
      if (!sourceRows.length) throw new Error('表格没有孕次数据');
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
      if (fields.some(f=>f.required&&mapping[f.key]<0)) throw new Error('请匹配所有必填字段：病案号、孕妇姓名、电话、孕次编号、胎数、随访项目');
      const selected = Object.values(mapping).filter(n => n >= 0);
      if (new Set(selected).size !== selected.length) throw new Error('同一列不能匹配到多个孕次字段');
      mappedRows = sourceRows.map(r => {
        const row = { row: r.row };
        fields.forEach(f => { row[f.key] = mapping[f.key] < 0 ? '' : r.values[mapping[f.key]] ?? ''; });
        return row;
      });
      checked = validateRows(mappedRows);
      const invalid = checked.filter(r => r.errors.length).length;
      const valid = checked.length - invalid;
      $('previewSummary').innerHTML = '<span>共 <b>' + checked.length + '</b> 行</span><span class="valid-count">可导入 <b>' + valid + '</b> 行</span><span class="invalid-count">待修正 <b>' + invalid + '</b> 行</span>';
      $('previewTbody').innerHTML = checked.slice(0, 50).map(r => '<tr><td>' + r.row + '</td><td>' + esc(r.data.patient_no) + '</td><td>' + esc(r.data.name) + '<small class="cell-sub">' + esc(r.data.pregnancy_no) + ' · '+esc(r.data.projects?.join?.(' / ')||'')+'</small></td><td>' + esc(r.data.phone) + '</td><td>' + (r.errors.length ? '<span class="validation-error">' + esc(r.errors.join('；')) + '</span>' : '<span class="badge resolved">格式正确</span>') + '</td></tr>').join('');
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
    const rows = [['原表行号', '病案号', '孕妇姓名', '手机号码', '孕次编号', '错误原因']].concat(checked.filter(r => r.errors.length).map(r => [r.row, r.data.patient_no, r.data.name, r.data.phone, r.data.pregnancy_no, r.errors.join('；')]));
    const ws = XLSX.utils.aoa_to_sheet(rows), wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '待修正数据'); XLSX.writeFile(wb, '孕次导入-错误明细.xlsx');
  };
  $('importConfirm').onclick = async () => {
    if (busy) return;
    busy = true; error('importError', '');
    ['importConfirm','importBack','closeImport','duplicateStrategy'].forEach(id => { $(id).disabled = true; });
    $('importConfirm').textContent = '正在保存…';
    try {
      const r = await api('prenatal_import', { rows: mappedRows, strategy: $('duplicateStrategy').value, source: $('selectedFileName').textContent, requestId });
      if (!r.ok) throw new Error(r.error || '导入失败，请重试');
      $('resultSummary').innerHTML = statsHtml([['新增孕次', r.inserted], ['更新孕次', r.updated], ['已有孕次跳过', r.skipped], ['无效行跳过', r.invalid]]);
      for(const issue of r.errors||[]){const item=checked.find(x=>x.row===issue.row);if(item)item.errors=issue.errors;}
      const failures=checked.filter(x=>x.errors.length);$('resultErrors').hidden=!failures.length;$('resultErrorList').textContent=failures.map(x=>'第'+x.row+'行：'+x.errors.join('；')).join(String.fromCharCode(10));
      setStep(2); load();
    } catch (e) { error('importError', e.message + '。可点击重试，同一次导入不会重复写入。'); }
    finally {
      busy = false;
      ['importConfirm','importBack','closeImport','duplicateStrategy'].forEach(id => { $(id).disabled = false; });
      $('importConfirm').textContent = '确认导入';
    }
  };
})();
