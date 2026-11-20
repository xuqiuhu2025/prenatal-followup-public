const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const XLSX = require('../webapp/vendor/xlsx.full.min.js');
const { validateRows } = require('../server/customer-validation');
const root = path.resolve('selfhost/webapp');
const out = path.resolve(process.env.QA_OUTPUT || '.backups/browser-check'); fs.mkdirSync(out, {recursive:true});
const rows = [];
const server = http.createServer(async (req, res) => {
  if (req.method === 'POST') {
    let body = ''; for await (const chunk of req) body += chunk;
    const e = JSON.parse(body); let result;
    if (e.action === 'login') result = {ok: true, token: 'qa'};
    else if (e.action === 'customer_list') {
      const found = rows.filter(r => !e.keyword || Object.values(r).some(v => String(v).includes(e.keyword)));
      result = {ok:true,list:found,total:found.length,summary:{total:rows.length,today:rows.length,companies:rows.length,tagged:rows.length}};
    } else if (e.action === 'customer_import') {
      result={ok:true,inserted:0,updated:0,skipped:0,invalid:0};
      for (const r of validateRows(e.rows)) { if(r.errors.length){result.invalid++;continue;} const previous=rows.find(p=>p.phone===r.data.phone); if(previous){result.skipped++;continue;} rows.push({...r.data,id:rows.length+1,updated_at:new Date().toISOString()});result.inserted++; }
    } else if (e.action === 'stats') result={ok:true,totals:{conversations:128,todayConversations:12,messages:500,satisfactionAvg:4.8,satisfactionCount:38,escalations:4,pendingEscalations:2,calls:6,completedCalls:4,pendingCalls:2},rates:{resolveRate:.92,escalationRate:.04},daily:[5,9,8,11,14,8,12].map((n,i)=>({date:'11/'+(i+4),conversations:n})),intentDist:{order_query:48,refund:24,faq:30,tech_support:18},ratingDist:{1:0,2:1,3:2,4:10,5:25}};
    else if(e.action === 'start') result={ok:true,messages:[{role:'assistant',content:'你好，我是小智。很高兴为你服务！\n关于订单、售后或产品使用，有什么我可以帮你的吗？'}]};
    else result={ok:true,list:[]};
    res.writeHead(200,{'Content-Type':'application/json'}); return res.end(JSON.stringify(result));
  }
  let url=new URL(req.url,'http://localhost').pathname;
  let file = url === '/js/customer-validation.js' ? path.resolve('selfhost/server/customer-validation.js') : path.join(root, url==='/' ? 'index.html' : url);
  try{const data=fs.readFileSync(file); const ext=path.extname(file);res.writeHead(200,{'Content-Type':({'.js':'text/javascript','.css':'text/css','.html':'text/html','.svg':'image/svg+xml'})[ext]||'application/octet-stream'});res.end(data);}catch{res.writeHead(404);res.end();}
});
(async()=>{
 await new Promise(r=>server.listen(18884,'127.0.0.1',r));
 const browser=await chromium.launch({headless:true}); const page=await browser.newPage({viewport:{width:1440,height:1000}}); const errors=[];page.on('pageerror',e=>errors.push(e.message));
 try{
 await page.goto('http://127.0.0.1:18884/admin.html'); await page.locator('#pwdInput').fill('qa');await page.locator('#btnLogin').click();await page.locator('#statCards .card').first().waitFor();
 await page.screenshot({path:path.join(out,'dashboard-desktop.png')});
 await page.locator('nav [data-page=customers]').click();await page.locator('#customerStats .card').first().waitFor();
 await page.screenshot({path:path.join(out,'customers-empty.png')});
 const downloadPromise=page.waitForEvent('download');await page.locator('#downloadTemplate').click();const download=await downloadPromise;await download.saveAs(path.join(out,'template.xlsx'));
 const template=XLSX.read(fs.readFileSync(path.join(out,'template.xlsx')), {type:'buffer'});assert.equal(XLSX.utils.sheet_to_json(template.Sheets[template.SheetNames[0]],{header:1})[0][0],'客户姓名');
 const table=[['客户姓名','手机号码','电子邮箱','公司 / 组织','客户标签','备注'],['测试客户甲',13800138000,'a@example.com','云舟示例公司','新客户','演示数据'],['测试客户乙','+86 139-0013-8000','','示例组织','意向客户','第二位'],['重复客户',13800138000,'','','',''],['错误号码','123','','','',''],['<img src=x onerror=alert(1)>','13700137000','','','','']];
 const wb=XLSX.utils.book_new();XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet(table),'客户');XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet([['姓名','手机号'],['备用',13600136000]]),'其他客户');
 await page.locator('#openImport').click();await page.locator('#customerFile').setInputFiles({name:'客户信息.xlsx',mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',buffer:Buffer.from(XLSX.write(wb,{type:'buffer',bookType:'xlsx'}))});
 await page.locator('#mappingArea').waitFor({state:'visible'}); assert.equal(await page.locator('[data-field=company]').inputValue(),'3');
 await page.screenshot({path:path.join(out,'import-mapping.png')});
 await page.locator('#importNext').click();await page.locator('#importPreview').waitFor({state:'visible'});assert.match(await page.locator('#previewSummary').innerText(),/可导入 3/);assert.equal(await page.locator('#previewTbody img').count(),0);
 await page.screenshot({path:path.join(out,'import-preview.png')});
 const errorsDownload=page.waitForEvent('download');await page.locator('#downloadErrors').click();assert.match((await errorsDownload).suggestedFilename(),/错误明细/);
 await page.locator('#importConfirm').click();await page.locator('#importResult').waitFor({state:'visible'});assert.equal(rows.length,3);await page.locator('#importDone').click();await page.locator('#customerTbody tr').first().waitFor();
 await page.screenshot({path:path.join(out,'customers-desktop.png')});
 await page.reload();await page.locator('#customerTbody tr').first().waitFor();assert.equal(await page.locator('#customerTbody tr').count(),3);
 for(const width of [320,768,1024,1440]){await page.setViewportSize({width,height:900});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'overflow '+width);if(width===320)await page.screenshot({path:path.join(out,'customers-mobile.png'),fullPage:true});}
 await page.setViewportSize({width:1440,height:1000});
 await page.locator('#openImport').click();await page.locator('#customerFile').setInputFiles({name:'中文.csv',mimeType:'text/csv',buffer:Buffer.from('\ufeff姓名,手机号,备注\r\nCSV客户,13500135000,"带逗号,和换行\n的备注"')});await page.locator('#mappingArea').waitFor({state:'visible'});await page.locator('#importNext').click();assert.match(await page.locator('#previewSummary').innerText(),/可导入 1/);await page.locator('#closeImport').click();
 await page.locator('#openImport').click();await page.locator('#customerFile').setInputFiles({name:'客户.xls',mimeType:'application/vnd.ms-excel',buffer:Buffer.from(XLSX.write(wb,{type:'buffer',bookType:'biff8'}))});await page.locator('#mappingArea').waitFor({state:'visible'});await page.locator('#sheetSelect').selectOption('其他客户');await page.locator('#importNext').click();assert.match(await page.locator('#previewSummary').innerText(),/可导入 1/);await page.locator('#closeImport').click();

 await page.locator('#openImport').click();await page.locator('#customerFile').setInputFiles({name:'empty.csv',mimeType:'text/csv',buffer:Buffer.from('姓名,手机号')});await page.locator('#importError').waitFor({state:'visible'});assert.equal(await page.locator('#importNext').isDisabled(),true);await page.locator('#closeImport').click();
 await page.locator('#openImport').click();await page.locator('#customerFile').setInputFiles({name:'missing.csv',mimeType:'text/csv',buffer:Buffer.from('姓名,备注\n王五,备注')});await page.locator('#mappingArea').waitFor({state:'visible'});await page.locator('#importNext').click();assert.match(await page.locator('#importError').innerText(),/匹配/);await page.locator('#closeImport').click();
 await page.locator('#openImport').click();await page.locator('#customerFile').setInputFiles({name:'large.csv',mimeType:'text/csv',buffer:Buffer.from('姓名,手机号\n'+Array(2001).fill('客户,13800138000').join('\n'))});await page.locator('#importError').waitFor({state:'visible'});assert.match(await page.locator('#importError').innerText(),/2,000/);await page.locator('#closeImport').click();
 await page.setViewportSize({width:320,height:900});await page.locator('#openImport').click();await page.screenshot({path:path.join(out,'import-mobile.png')});assert.ok(await page.evaluate(()=>{const d=document.getElementById('importDialog');return d.getBoundingClientRect().right<=innerWidth&&d.scrollWidth<=d.clientWidth;}));await page.locator('#closeImport').click();await page.setViewportSize({width:1440,height:1000});

 await page.goto('http://127.0.0.1:18884/index.html');await page.locator('.msg.assistant').waitFor();await page.screenshot({path:path.join(out,'chat-desktop.png')});
 for(const width of [320,768,1024,1440]){await page.setViewportSize({width,height:900});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'chat overflow '+width);if(width===320)await page.screenshot({path:path.join(out,'chat-mobile.png')});}
 assert.deepEqual(errors,[]);console.log('PASS browser: login, template download, XLSX/XLS/CSV, sheet selection, mapping, preview, duplicate validation, errors download, import result, reload, escaped content, 320/768/1024/1440 layouts');
 }finally{await browser.close();server.close();}
})().catch(e=>{console.error(e);process.exitCode=1;server.close();});
