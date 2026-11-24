import {cancelledTask,ledgerCancelledCount,siteSideTask} from './dashboard-model.mjs';
import {businessDayHistory} from './business-day-history.mjs';
import {siteFaultCodes} from './checkin-contract.generated.mjs';
import {siteHarvestWait,waitingTask,harvestWaitSummary} from './harvest-window.mjs';

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const verdictPresentation=new Map([
  ['done',{group:'completed',status:'signed',label:'已签到'}],
  ['paused',{group:'cancelled',status:'not_available',label:'已取消'}],
  ['noFeature',{group:'unavailable',status:'not_available',label:'无此功能'}],
  ['external',{group:'external',status:'deferred',label:'站点异常'}],
  ['actionNeeded',{group:'pending',status:'needs_attention',label:'需处理'}],
  ['verifying',{group:'pending',status:'deferred',label:'待核验'}]
]);
const waitingPresentation={group:'waiting',status:'deferred',label:'等待执行'};

export function calendarReceiptVerdict(task,now=Date.now()){
  if(task?.calendarVerdict==='verifying'&&waitingTask(task,now))return waitingPresentation;
  return verdictPresentation.get(task?.calendarVerdict);
}

export function validWorkloadVerdict(items){
  if(!Array.isArray(items)||items.length>700)return false;
  const valid=items.every(item=>typeof item?.taskId==='string'&&
    /^(?:task_[a-f0-9]{24}|pt_[a-f0-9]{16})$/.test(item.taskId)&&verdictPresentation.has(item.class));
  return valid&&new Set(items.map(item=>item.taskId)).size===items.length;
}

export function calendarWorkloadVerdict(tasks,ptStatus,classFor){
  const siteRefs=new Map();
  for(const site of ptStatus?.sites??[]){
    // An origin with two possible bindings cannot identify one archived PT row.
    siteRefs.set(site.origin,siteRefs.has(site.origin)?null:site.siteRef);
  }
  const items=tasks.map(task=>({taskId:task.ptSupplementOnly?siteRefs.get(task.origin):task.taskId,class:classFor(task)}));
  return validWorkloadVerdict(items)?items:undefined;
}

// An exact, dated workload projection is optional on older ledger generations.
// Only expose ids that still match a unique regular or supplemental calendar row.
function calendarVerdictRows(items,tasks){
  if(!validWorkloadVerdict(items))return null;
  const byId=new Map(tasks.map(task=>[task.taskId,task])),rows=[];
  if(byId.size!==tasks.length)return null;
  for(const item of items){
    if(!byId.has(item.taskId))return null;
    rows.push({...byId.get(item.taskId),calendarVerdict:item.class});
  }
  return rows;
}

function scopedEntry(entry,scope){
  const regular=(entry.tasks??[]).filter(task=>task.ptSupplementOnly!==true),pt=entry.ptSummaries?.map(task=>{
    // Recover only the exact diagnostics produced by older project versions;
    // arbitrary page wording is never promoted to success or availability.
    const summary=task.evidence?.summary;
    const condition=task.condition??(summary==='站点公告正在维护或恢复数据，等待恢复后核验'?'site_maintenance':
      summary==='站点服务端返回故障，等待恢复后核验'?'upstream_unavailable':undefined);
    return {...task,...(condition?{condition}:{}),
      ...(condition==='upstream_unavailable'&&!task.failureCode?{failureCode:'site_server_error'}:{})};
  });
  if(scope==='regular'||!Array.isArray(pt)&&scope==='all')return {...entry,ptRecorded:Array.isArray(pt)};
  let selected=scope==='pt'?(Array.isArray(pt)?pt:regular.filter(t=>t.taskKind==='pt')):[...regular];
  if(scope==='all')for(const item of pt??[]){
    const matches=selected.map((task,index)=>({task,index})).filter(({task})=>task.origin===item.origin&&
      (!item.accountRef||!task.accountRef||task.accountRef===item.accountRef));
    if(matches.length===1){
      const {task,index}=matches[0];selected[index]={...task,taskKind:'pt',observedStatus:item.observedStatus,
        observedAt:item.observedAt,evidence:item.evidence,...(item.condition?{condition:item.condition}:{}),
        ...(item.failureCode?{failureCode:item.failureCode}:{})};
    }else if(!item.inLegacyPlan)selected.push(item);
  }
  let verdictRows=scope==='all'?calendarVerdictRows(entry.workloadVerdict,selected):null;
  if(verdictRows&&regular.some(task=>!verdictRows.some(row=>row.taskId===task.taskId)))verdictRows=null;
  if(verdictRows)selected=verdictRows;
  const status={};for(const task of selected)status[task.observedStatus]=(status[task.observedStatus]??0)+1;
  return {...entry,tasks:selected,counts:{executionUnits:selected.length,status},ptRecorded:Array.isArray(pt),verdictRecorded:Boolean(verdictRows)};
}

export function calendarPtSummaries(ptStatus,now=Date.now()){
  if(!Array.isArray(ptStatus?.sites))return null;
  return ptStatus.sites.map(site=>{const waiting=siteHarvestWait(site,ptStatus.harvestWindow,now);return {taskId:site.siteRef,origin:site.origin,accountRef:site.accountRef??null,
    displayName:site.displayName,taskKind:'pt',businessDate:ptStatus.businessDate,inLegacyPlan:site.inLegacyPlan===true,
    ...(waiting?{waiting,ptSupplementOnly:true}:{}),
    observedStatus:site.effective?.fresh?site.effective.status:'unknown',observedAt:site.effective?.observedAt??null,
    ...(site.effective?.siteCondition==='site_maintenance'?{condition:'site_maintenance'}:
      siteFaultCodes.includes(site.effective?.failureCode)?{condition:'upstream_unavailable',failureCode:site.effective.failureCode}:{}),
    evidence:site.effective?.evidence?.verification==='task_disabled'
      ?{...site.effective.evidence,rawSource:'configuration'}:waiting?{...site.effective?.evidence,summary:harvestWaitSummary(waiting)}:site.effective?.evidence??null};});
}

export function dailyRecords({ledger = [], snapshot = null, tasks = [],ptStatus=snapshot?.ptStatus,scope='all',now=Date.now()} = {}) {
  const days = new Map();
  for (const record of businessDayHistory(ledger).values()) {
    if (!DAY.test(record?.businessDate ?? '')) continue;
    const previous = days.get(record.businessDate);
    if (!previous || Date.parse(record.recordedAt) > Date.parse(previous.recordedAt)) {
      days.set(record.businessDate, {recordedAt:record.recordedAt, counts:record.counts,
        tasks:record.taskSummaries,ptSummaries:record.ptSummaries,workloadVerdict:record.workloadVerdict,source:'ledger'});
    }
  }
  if (DAY.test(snapshot?.businessDate ?? '') && Array.isArray(tasks) && tasks.length) {
    const previous = days.get(snapshot.businessDate);
    const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(new Date(now));
    const currentDay=snapshot.businessDate===today;
    // Live freshness is measured against today. It must never downgrade an
    // archived receipt after midnight while the next snapshot is still pending.
    if (!previous || currentDay&&Date.parse(snapshot.generatedAt) >= Date.parse(previous.recordedAt)) {
      days.set(snapshot.businessDate, {recordedAt:snapshot.generatedAt, counts:snapshot.counts,
        tasks,ptSummaries:currentDay?calendarPtSummaries(ptStatus,new Date(now).getTime()):null,
        workloadVerdict:currentDay&&ptStatus?.businessDate===snapshot.businessDate
          ?calendarWorkloadVerdict(tasks,ptStatus,task=>task.dayClass):undefined,
        source:currentDay?'current':'snapshot'});
    }
  }
  return new Map([...days].map(([day,entry])=>[day,scopedEntry(entry,scope)]));
}

export function monthCells(month) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw Error('invalid month');
  const [year, number] = month.split('-').map(Number);
  const first = new Date(Date.UTC(year, number - 1, 1));
  return {offset:(first.getUTCDay() + 6) % 7, days:new Date(Date.UTC(year, number, 0)).getUTCDate()};
}

export function moveMonth(month, offset) {
  const [year, number] = month.split('-').map(Number);
  const date = new Date(Date.UTC(year, number - 1 + offset, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

function dateValue(value){
  const date=new Date(`${value}T12:00:00Z`);
  if(!DAY.test(value??'')||!Number.isFinite(date.getTime())||date.toISOString().slice(0,10)!==value)throw Error('invalid calendar date');
  return date;
}
function boundDate(value,{minimum='0001-01-01',maximum='9999-12-31'}={}){
  const lower=dateValue(minimum),upper=dateValue(maximum),date=value instanceof Date?value:dateValue(value);
  if(minimum>maximum||!Number.isFinite(date.getTime()))throw Error('invalid calendar bounds');
  return date<lower?minimum:date>upper?maximum:date.toISOString().slice(0,10);
}
export function moveCalendarDay(date,offset,bounds){
  if(!Number.isInteger(offset))throw Error('invalid day offset');
  const value=dateValue(date);value.setUTCDate(value.getUTCDate()+offset);
  return boundDate(value,bounds);
}
export function selectCalendarMonth(date,month,bounds){
  dateValue(date);
  const day=Math.min(Number(date.slice(8)),monthCells(month).days);
  return boundDate(`${month}-${String(day).padStart(2,'0')}`,bounds);
}

export function dayTotals(entry,now=Date.now()) {
  if(entry?.verdictRecorded){
    const totals={total:entry.tasks.length,completed:0,unavailable:0,cancelled:0,external:0,waiting:0,pending:0};
    for(const task of entry.tasks)totals[calendarTaskGroup(task,now)]++;
    return totals;
  }
  const status = entry?.counts?.status ?? {};
  const total = entry?.counts?.executionUnits ?? 0;
  const completed = (status.signed ?? 0) + (status.already_signed ?? 0);
  const cancelled = ledgerCancelledCount(entry);
  const unavailable = Math.max(0,(status.not_available ?? 0)-cancelled);
  const external=Math.min(Math.max(0,total-completed-unavailable-cancelled),(entry?.tasks??[]).filter(siteSideTask).length);
  const waiting=(entry?.tasks??[]).filter(task=>waitingTask(task,now)).length;
  return {total, completed, unavailable, cancelled, external,waiting,pending:Math.max(0,total-completed-unavailable-cancelled-external-waiting)};
}

export function monthTotals(records,month,now=Date.now()) {
  const result={recordDays:0,total:0,completed:0,unavailable:0,cancelled:0,external:0,waiting:0,pending:0};
  for(const [date,entry] of records){
    if(!date.startsWith(`${month}-`))continue;
    const totals=dayTotals(entry,now);
    result.recordDays++;
    for(const key of ['total','completed','unavailable','cancelled','external','waiting','pending'])result[key]+=totals[key];
  }
  return result;
}

export function calendarTaskGroup(value,now=Date.now()) {
  const task=typeof value==='string'?{observedStatus:value}:value,status=task?.observedStatus;
  const verdict=calendarReceiptVerdict(task,now);
  if(verdict)return verdict.group;
  if(cancelledTask(task))return 'cancelled';
  if(['signed','already_signed'].includes(status))return 'completed';
  if(status==='not_available')return 'unavailable';
  if(waitingTask(task,now))return 'waiting';
  if(siteSideTask(task))return 'external';
  return 'pending';
}

export function calendarTasks(entry,filter='all') {
  const priority={pending:0,waiting:1,external:2,completed:3,unavailable:4,cancelled:5};
  return [...(entry?.tasks??[])].filter(task=>filter==='all'||calendarTaskGroup(task)===filter)
    .sort((a,b)=>priority[calendarTaskGroup(a)]-priority[calendarTaskGroup(b)]||
      String(a.displayName??a.origin??'').localeCompare(String(b.displayName??b.origin??''),'zh-CN'));
}
