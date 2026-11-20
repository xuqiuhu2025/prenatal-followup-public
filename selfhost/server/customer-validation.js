(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CustomerData = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  var fields = [
    { key: 'name', label: '客户姓名', required: true, max: 80, aliases: ['姓名', '客户姓名', '客户名称', '联系人', 'name', 'customername'] },
    { key: 'phone', label: '手机号码', required: true, max: 40, aliases: ['手机', '手机号', '手机号码', '联系电话', '电话', 'phone', 'mobile', 'tel'] },
    { key: 'email', label: '电子邮箱', max: 254, aliases: ['邮箱', '电子邮箱', 'email'] },
    { key: 'company', label: '公司 / 组织', max: 120, aliases: ['公司', '公司/组织', '公司名称', '企业', '组织', 'company', 'organization'] },
    { key: 'tags', label: '客户标签', max: 160, aliases: ['标签', '客户标签', '分类', 'tags', 'tag'] },
    { key: 'notes', label: '备注', max: 1000, aliases: ['备注', '说明', '客户备注', 'notes', 'note', 'remark'] }
  ];
  function normalizePhone(value) {
    return String(value == null ? '' : value).trim().replace(/[\s()（）-]/g, '').replace(/^(?:\+86|0086)(?=1\d{10}$)/, '');
  }
  function guessMapping(headers) {
    var mapping = {};
    fields.forEach(function (f) {
      mapping[f.key] = headers.findIndex(function (h) {
        return f.aliases.indexOf(String(h).toLowerCase().replace(/[\s_*（必填）()]/g, '')) >= 0;
      });
    });
    return mapping;
  }
  function validateRows(rows) {
    if (!Array.isArray(rows) || !rows.length || rows.length > 2000) throw new Error('每次请导入 1–2000 行客户数据');
    var seen = new Set();
    return rows.map(function (row, i) {
      row = row && typeof row === 'object' ? row : {};
      var data = {}, errors = [];
      fields.forEach(function (f) {
        var v = row[f.key];
        if (v != null && typeof v !== 'string' && typeof v !== 'number') { errors.push(f.label + '格式不正确'); v = ''; }
        data[f.key] = String(v == null ? '' : v).trim();
        if (f.required && !data[f.key]) errors.push(f.label + '不能为空');
        if (data[f.key].length > f.max) errors.push(f.label + '最多 ' + f.max + ' 个字符');
      });
      data.phone = normalizePhone(data.phone);
      if (data.phone && !/^1[3-9]\d{9}$/.test(data.phone)) errors.push('手机号须为 11 位中国大陆手机号');
      if (data.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)) errors.push('邮箱格式不正确');
      if (errors.length === 0 && seen.has(data.phone)) errors.push('表格内手机号重复，保留第一条有效记录');
      if (!errors.length) seen.add(data.phone);
      return { row: Number.isSafeInteger(row.row) && row.row > 0 ? row.row : i + 2, data: data, errors: errors };
    });
  }
  return { fields: fields, normalizePhone: normalizePhone, guessMapping: guessMapping, validateRows: validateRows };
});
