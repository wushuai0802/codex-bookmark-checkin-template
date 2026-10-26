const datePattern=/^\d{4}-\d{2}-\d{2}$/;
const dayAt=value=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(new Date(value));

// A live sync before the next runner starts can still refer to yesterday's
// run. Retain that audit event, but never use today's observation to close
// yesterday's calendar or health window.
export function isBusinessDayRecord(record){
  const day=record?.businessDate,at=Date.parse(record?.recordedAt??'');
  if(!datePattern.test(day??'')||!Number.isFinite(at))return false;
  // New records carry the observation date explicitly: persisting a snapshot
  // a moment after midnight must not discard a genuine pre-midnight receipt.
  if((record.observationBusinessDate??dayAt(at))!==day)return false;
  if(record.ptBusinessDate&&record.ptBusinessDate!==day)return false;
  return true;
}

export function businessDayHistory(records=[]){
  const days=new Map();
  for(const record of records){
    if(!isBusinessDayRecord(record))continue;
    const previous=days.get(record.businessDate);
    if(!previous||Date.parse(record.recordedAt)>=Date.parse(previous.recordedAt))days.set(record.businessDate,record);
  }
  return days;
}
