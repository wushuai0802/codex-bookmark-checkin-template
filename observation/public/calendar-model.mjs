const DAY = /^\d{4}-\d{2}-\d{2}$/;

export function dailyRecords({ledger = [], snapshot = null, tasks = []} = {}) {
  const days = new Map();
  for (const record of ledger) {
    if (!DAY.test(record?.businessDate ?? '')) continue;
    const previous = days.get(record.businessDate);
    if (!previous || Date.parse(record.recordedAt) > Date.parse(previous.recordedAt)) {
      days.set(record.businessDate, {recordedAt:record.recordedAt, counts:record.counts,
        tasks:record.taskSummaries, source:'ledger'});
    }
  }
  if (DAY.test(snapshot?.businessDate ?? '') && Array.isArray(tasks) && tasks.length) {
    const previous = days.get(snapshot.businessDate);
    if (!previous || Date.parse(snapshot.generatedAt) >= Date.parse(previous.recordedAt)) {
      days.set(snapshot.businessDate, {recordedAt:snapshot.generatedAt, counts:snapshot.counts,
        tasks, source:'current'});
    }
  }
  return days;
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

export function dayTotals(entry) {
  const status = entry?.counts?.status ?? {};
  const total = entry?.counts?.executionUnits ?? 0;
  const completed = (status.signed ?? 0) + (status.already_signed ?? 0);
  const unavailable = status.not_available ?? 0;
  return {total, completed, unavailable, pending:Math.max(0,total-completed-unavailable)};
}
