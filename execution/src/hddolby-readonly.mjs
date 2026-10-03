const originAllowed='https://www.hddolby.com';
const day=value=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(new Date(value));
const unknown=code=>({status:'unknown',failureCode:code??'authoritative_status_unavailable',submissionAttempted:false});

export function hddolbyHeaderSigned(header){
  if(!header?.authenticated||!Array.isArray(header.userIds)||header.userIds.length!==1||header.unsigned)return false;
  const text=String(header.text??'');
  const signals=[...text.matchAll(/(?:^|[\s(（])(?:签到已得|簽到已得)\s*([0-9][0-9,.]*)(?=$|[\s)）])/g)];
  return signals.length===1&&Number.isFinite(Number(signals[0][1].replaceAll(',','')))&&
    !/(?:历史|歷史|累计|累計|昨日|昨天|本月|总计|總計).{0,20}(?:签到已得|簽到已得)/.test(text);
}

export function hddolbyDailyProof(result,now=new Date()){
  const evidence=result?.evidence,at=Date.parse(evidence?.confirmedAt??'');
  return result?.status==='already_signed'&&result.submissionAttempted===false&&evidence?.source==='pt_page'&&
    evidence.authoritative===true&&evidence.statusSignal==='hddolby_account_header_signed'&&evidence.pagePath==='/log.php'&&
    Number.isFinite(at)&&at<=now.getTime()+60_000&&now.getTime()-at<=5*60_000&&
    day(at)===day(now)&&evidence.businessDate===day(now);
}

// The current user's header on this ordinary page supplies the daily reward.
// The page itself may deny access to site logs; no public log row is trusted.
export async function readHddolbyHeader(context,{origin=originAllowed,now=new Date(),extractHeader}={}){
  if(origin!==originAllowed)throw Error('HDDolby read origin is not reviewed');
  let parser;
  const extract=extractHeader??(async(html,url)=>{
    if(!parser){
      parser=await context.newPage();
      await parser.route('**/*',route=>route.abort('blockedbyclient'));
    }
    // Parse inert HTML even when the caller's execution context enables JS.
    await parser.setContent('<meta http-equiv="Content-Security-Policy" content="default-src &#39;none&#39;; script-src &#39;none&#39;; form-action &#39;none&#39;">'+html,{waitUntil:'domcontentloaded'});
    return parser.evaluate(base=>{
      const header=document.querySelector('#info_block');if(!header)return null;
      const links=[...header.querySelectorAll('a')].flatMap(link=>{
        try{const u=new URL(link.getAttribute('href')??'',base);return u.origin===new URL(base).origin?[{url:u,text:link.textContent.trim().replace(/^[\[【]|[\]】]$/g,'')}]:[];}catch{return [];}
      });
      const userIds=[...new Set(links.filter(link=>link.url.pathname==='/userdetails.php'&&
        [...link.url.searchParams.keys()].every(key=>key==='id')).map(link=>link.url.searchParams.get('id')).filter(id=>/^\d{1,20}$/.test(id??'')))];
      const controlPanel=[...document.querySelectorAll('a')].some(link=>{
        try{const u=new URL(link.getAttribute('href')??'',base);return u.origin===new URL(base).origin&&u.pathname==='/usercp.php';}catch{return false;}
      });
      return {text:header.textContent.trim(),authenticated:links.some(link=>link.url.pathname==='/logout.php')&&
        controlPanel,userIds,
        unsigned:links.some(link=>link.url.pathname==='/attendance.php'&&['签到','签到得魔力','立即签到'].includes(link.text)),
        logLinked:[...document.querySelectorAll('a')].some(link=>{
          try{const u=new URL(link.getAttribute('href')??'',base);return u.origin===new URL(base).origin&&u.pathname==='/log.php'&&!u.search&&!u.hash;}catch{return false;}
        })};
    },url);
  });
  const read=async path=>{
    const url=origin+path,response=await context.request.get(url,{timeout:15000,maxRedirects:0,headers:{'Cache-Control':'no-cache'}});
    if(response.status()!==200||response.url()!==url)return null;
    const at=Date.parse(response.headers().date??'');
    if(!Number.isFinite(at)||day(at)!==day(now)||Math.abs(at-now.getTime())>5*60_000)return null;
    return extract(await response.text(),url);
  };
  try{
    const index=await read('/index.php');
    if(!index?.authenticated||index.userIds?.length!==1||!index.logLinked)return unknown();
    const header=await read('/log.php');
    if(!header?.authenticated||header.userIds?.length!==1)return unknown();
    if(header.userIds[0]!==index.userIds[0])return unknown('account_mismatch');
    if(!hddolbyHeaderSigned(header))return unknown();
    return {status:'already_signed',submissionAttempted:false,evidence:{source:'pt_page',authoritative:true,
      confirmedAt:now.toISOString(),businessDate:day(now),pagePath:'/log.php',statusSignal:'hddolby_account_header_signed'}};
  }catch{return unknown('network_error');}
  finally{await parser?.close().catch(()=>{});}
}
