const DAY = /^\d{4}-\d{2}-\d{2}$/;

function scopedEntry(entry,scope){
  const regular=entry.tasks??[],pt=entry.ptSummaries;
  if(scope==='regular'||!Array.isArray(pt)&&scope==='all')return {...entry,ptRecorded:Array.isArray(pt)};
  let selected=scope==='pt'?(Array.isArray(pt)?pt:regular.filter(t=>t.taskKind==='pt')):[...regular];
  if(scope==='all')for(const item of pt??[]){
    const matches=selected.map((task,index)=>({task,index})).filter(({task})=>task.origin===item.origin&&
      (!item.accountRef||!task.accountRef||task.accountRef===item.accountRef));
    if(matches.length===1){
      const {task,index}=matches[0];selected[index]={...task,taskKind:'pt',observedStatus:item.observedStatus,
        observedAt:item.observedAt,evidence:item.evidence};
    }else if(!item.inLegacyPlan)selected.push(item);
  }
  const status={};for(const task of selected)status[task.observedStatus]=(status[task.observedStatus]??0)+1;
  return {...entry,tasks:selected,counts:{executionUnits:selected.length,status},ptRecorded:Array.isArray(pt)};
}

export function calendarPtSummaries(ptStatus){
  if(!Array.isArray(ptStatus?.sites))return null;
  return ptStatus.sites.map(site=>({taskId:site.siteRef,origin:site.origin,accountRef:site.accountRef??null,
    displayName:site.displayName,taskKind:'pt',inLegacyPlan:site.inLegacyPlan===true,
    observedStatus:site.effective?.fresh?site.effective.status:'unknown',observedAt:site.effective?.observedAt??null,
    evidence:site.effective?.evidence??null}));
}

export function dailyRecords({ledger = [], snapshot = null, tasks = [],ptStatus=snapshot?.ptStatus,scope='all'} = {}) {
  const days = new Map();
  for (const record of ledger) {
    if (!DAY.test(record?.businessDate ?? '')) continue;
    const previous = days.get(record.businessDate);
    if (!previous || Date.parse(record.recordedAt) > Date.parse(previous.recordedAt)) {
      days.set(record.businessDate, {recordedAt:record.recordedAt, counts:record.counts,
        tasks:record.taskSummaries,ptSummaries:record.ptSummaries, source:'ledger'});
    }
  }
  if (DAY.test(snapshot?.businessDate ?? '') && Array.isArray(tasks) && tasks.length) {
    const previous = days.get(snapshot.businessDate);
    if (!previous || Date.parse(snapshot.generatedAt) >= Date.parse(previous.recordedAt)) {
      days.set(snapshot.businessDate, {recordedAt:snapshot.generatedAt, counts:snapshot.counts,
        tasks,ptSummaries:calendarPtSummaries(ptStatus), source:'current'});
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

export function dayTotals(entry) {
  const status = entry?.counts?.status ?? {};
  const total = entry?.counts?.executionUnits ?? 0;
  const completed = (status.signed ?? 0) + (status.already_signed ?? 0);
  const unavailable = status.not_available ?? 0;
  return {total, completed, unavailable, pending:Math.max(0,total-completed-unavailable)};
}

export function monthTotals(records,month) {
  const result={recordDays:0,total:0,completed:0,unavailable:0,pending:0};
  for(const [date,entry] of records){
    if(!date.startsWith(`${month}-`))continue;
    const totals=dayTotals(entry);
    result.recordDays++;
    for(const key of ['total','completed','unavailable','pending'])result[key]+=totals[key];
  }
  return result;
}

export function calendarTaskGroup(status) {
  if(['signed','already_signed'].includes(status))return 'completed';
  if(status==='not_available')return 'unavailable';
  return 'pending';
}

export function calendarTasks(entry,filter='all') {
  const priority={pending:0,completed:1,unavailable:2};
  return [...(entry?.tasks??[])].filter(task=>filter==='all'||calendarTaskGroup(task.observedStatus)===filter)
    .sort((a,b)=>priority[calendarTaskGroup(a.observedStatus)]-priority[calendarTaskGroup(b.observedStatus)]||
      String(a.displayName??a.origin??'').localeCompare(String(b.displayName??b.origin??''),'zh-CN'));
}
