const {test}=require('node:test'),assert=require('node:assert/strict'),D=require('../server/prenatal-data');
const c={pregnancy_no:'2026-001',fetus_count:2,lmp:'2026-01-01',edd:'2026-10-08',projects:['serum','genetic']};
test('pregnancy import identity, projects, fetus count and chronology',()=>{
 const row={...c,patient_no:'P001',name:'测试孕妇',phone:'13800138000',projects:'血清学产前筛查,遗传学产前诊断'};
 const rows=D.validateRows([row,{...row,pregnancy_no:'2027-001'},row]);assert.deepEqual(rows[0].errors,[]);assert.deepEqual(rows[1].errors,[]);assert.match(rows[2].errors.join(),/重复/);
 assert.throws(()=>D.validateCase({...c,fetus_count:''}),/胎数/);assert.throws(()=>D.validateCase({...c,edd:'2025-01-01'}),/预产期/);assert.throws(()=>D.validateCase({...c,projects:['fake']}),/项目/);
 assert.equal(D.guessMapping(['病案号','孕妇姓名','孕次编号','胎数']).pregnancy_no,2);
});
test('screening and diagnostic reports remain distinct',()=>{
 assert.equal(D.report({screen_risk:'high',diagnosis_result:'abnormal'},'serum').diagnosis_result,undefined);
 assert.equal(D.report({screen_risk:'high',diagnosis_result:'abnormal'},'genetic').screen_risk,undefined);
 assert.throws(()=>D.report({sample_date:'2026-01-02',report_date:'2026-01-01'},'nipt'));
 assert.equal(D.allowed('serum','procedure'),false);assert.equal(D.allowed('genetic','procedure'),true);assert.equal(D.allowed('ultrasound_dx','notification'),false);
});
test('per-fetus outcomes and mixed twin postnatal applicability',()=>{
 const base={followup_date:'2026-10-01',evidence:'record'};
 const mixed=[{outcome:'live_birth',outcome_date:'2026-06-01',evidence:'record'},{outcome:'termination',outcome_date:'2026-04-01',evidence:'record'}];
 assert.equal(D.clinical({...base,fetuses:mixed},'outcome',2).fetuses.length,2);
 assert.throws(()=>D.clinical({...base,fetuses:mixed.slice(0,1)},'outcome',2));
 assert.throws(()=>D.clinical({...base,fetuses:[{outcome:'ongoing',outcome_date:'2026-01-01'}]},'outcome',1));
 const post=[{birth_date:'2026-06-01',child_health:'no_issue_reported',evidence:'family'},{applicability:'not_liveborn',notes:'胎儿2已终止妊娠',evidence:'record'}];
 assert.equal(D.clinical({...base,fetuses:post},'postnatal',2).fetuses[1].applicability,'not_liveborn');
 assert.throws(()=>D.clinical({...base,fetuses:[{...post[0],confirmation:'confirmed'}]},'postnatal',1),/依据/);
 assert.throws(()=>D.clinical({...base,counseling:'completed',counseling_date:'2026-10-02',counseling_org:'中心'},'notification',1),/晚于/);
});
