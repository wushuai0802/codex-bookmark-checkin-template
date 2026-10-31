export {confirmedPtByTask} from '../public/pt-evidence.mjs';
import {authorizedWorkload} from './workload-view.mjs';

// Shared by the dashboard and the daily notification projection. This reads
// already-published evidence and cannot change execution or submission history.
export function verdictSnapshot(snapshot,{now=new Date()}={}){
  const workload=authorizedWorkload({...snapshot,now:new Date(now).getTime()});
  return {...snapshot,tasks:workload.tasks};
}
