import { shanghaiDate, timestampFresh } from './freshness.mjs';
import { shortLabel } from './display-identity.mjs';
export const PT_READONLY_CAPABILITY = Object.freeze({id:'pt-native-readonly.v1',mode:'observe_only',methods:Object.freeze(['GET']),canSubmit:false,canRecoverLogin:false});
function httpsOrigin(value){const url=new URL(value);if(url.protocol!=='https:'||url.username||url.password||url.origin!==value)throw Error('invalid PT origin');return url.origin;}
export function parsePtPageEvidence({text='',origin,now=new Date().toISOString(),observedAt,recordDate,expectedId,identity,source='page_text'}={}){
 const businessDate=shanghaiDate(now),result={schemaVersion:1,adapter:PT_READONLY_CAPABILITY.id,mode:'observe_only',origin:null,status:'unknown',cause:null,businessDate,observedAt:null,identity:null,evidence:null,mutationCount:0},stop=cause=>({...result,cause});
 try{result.origin=httpsOrigin(origin);}catch{return stop('origin_invalid');}
 if(!['page_text','harvest'].includes(source))return stop('source_unsupported');
 if(!timestampFresh(observedAt,now)||shanghaiDate(observedAt)!==businessDate)return stop('observation_stale');result.observedAt=new Date(observedAt).toISOString();
 if(!/^[1-9][0-9]{0,19}$/.test(String(expectedId??'')))return stop('expected_identity_missing');
 if(identity?.verified!==true||identity.origin!==origin||String(identity.userId)!==String(expectedId))return stop('identity_mismatch');
 if(!timestampFresh(identity.observedAt,now)||shanghaiDate(identity.observedAt)!==businessDate)return stop('identity_stale');
 result.identity={userId:String(expectedId),username:shortLabel(identity.username),verified:true,origin,observedAt:identity.observedAt};
 if(recordDate!==businessDate)return stop('record_date_mismatch');
 if(typeof text!=='string'||!text.trim()||text.length>5000||/<[^>]*>|\x00/.test(text))return stop('status_text_invalid');
 const body=text.replace(/\s+/g,' ').trim(),dates=body.match(/\d{4}-\d{2}-\d{2}/g)??[];if(dates.some(date=>date!==recordDate))return stop('text_date_conflict');
 if(/请(?:先)?登录|登入後|登录状态.*失效|验证您不是|人机验证|verify you are human|just a moment/i.test(body))return stop('login_or_challenge');
 const signed=/今日已签到|今日已簽到|今天已经签到|签到成功|簽到成功|successfully checked in|already (?:signed|checked in) today/i.test(body)||/^成功[,，].*已连续签到\d+天/.test(body)||/今日签到排名.*这是您的第\d+次签到.*本次签到获得/.test(body);
 const unsigned=/(?:今日|今天)(?:尚|还)?未[簽签]到|not (?:signed|checked in) today/i.test(body),failed=/[簽签]到失败|check.?in failed|请求失败/i.test(body),maintenance=/系统维护中|站点维护中|签到功能未(?:启用|开放)|check.?in (?:is )?disabled/i.test(body);
 if(signed&&(unsigned||failed||maintenance))return stop('conflicting_status_text');if(maintenance)return stop('maintenance_notice');if(failed)return stop('failed_attempt_not_business_state');if(!signed&&!unsigned)return stop('status_not_proven');
 result.status=signed?'signed':'not_signed';result.evidence={source,authoritative:true,userId:String(expectedId),origin,businessDate,observedAt:result.observedAt,summary:signed?'同账号当日签到回执确认':'同账号当日未签到状态确认',redacted:true};return result;
}
export function classifyPtResponse({statusCode=0,...observation}={}){if(statusCode===401)return{status:'unknown',cause:'login_required'};if(statusCode===403)return{status:'unknown',cause:'access_challenge'};if(statusCode===429)return{status:'unknown',cause:'rate_limit'};if(statusCode===404)return{status:'unknown',cause:'endpoint_changed'};if(statusCode!==200)return{status:'unknown',cause:'upstream_unavailable'};return parsePtPageEvidence(observation);}
export function validatePtReadRequest(origin,url,method='GET',policy={}){httpsOrigin(origin);const target=new URL(url,origin),action=/(?:attendance|check[-_]?in|sign[_-]?(?:in|out)?|logout|bonus|invite|thanks|delete|confirm)/i;if(method!=='GET'||target.origin!==origin||target.username||target.password||target.hash||action.test(decodeURIComponent(target.pathname))||policy.readOnlyReviewed!==true||!Array.isArray(policy.allowedUrls)||!policy.allowedUrls.includes(target.href)||[...target.searchParams.keys()].some(key=>!['id','page'].includes(key))||[...target.searchParams.values()].some(value=>!/^\d+$/.test(value)))throw Error('PT read-only request denied');return target;}
