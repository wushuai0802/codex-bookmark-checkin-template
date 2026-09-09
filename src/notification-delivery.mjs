import {createNotificationOutboxItem} from './candidate-protocol.mjs';

export function createDelivery(receipt,{channel='telegram',now=new Date().toISOString()}={}) {
  return createNotificationOutboxItem({receipt,channel,createdAt:now});
}

export async function deliverNotification(item,{send,now=new Date().toISOString()}={}) {
  if(!item||item.state!=='pending') return item;
  if(typeof send!=='function') return {...item,state:'failed',attempts:item.attempts+1,lastError:'sender_unavailable',nextAttemptAt:new Date(Date.parse(now)+300_000).toISOString()};
  try { await send(item.payload); return {...item,state:'delivered',attempts:item.attempts+1,deliveredAt:new Date(now).toISOString()}; }
  catch { return {...item,state:'pending',attempts:item.attempts+1,lastError:'delivery_failed',nextAttemptAt:new Date(Date.parse(now)+300_000).toISOString()}; }
}
