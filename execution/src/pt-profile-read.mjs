// Ourbits exposes today's reward in the signed-in user's profile header;
// its index and native accessibility header can omit that same field.
export async function readOurbitsProfile(context, {origin, now=new Date(), extractHeader}={}) {
  if(origin!=='https://ourbits.club')throw Error('Unreviewed profile read origin');
  await context.route('**/*',route=>route.abort('blockedbyclient'));
  let page;
  const snapshot=extractHeader??(async(html,url)=>{
    page??=await context.newPage();
    await page.setContent(html,{waitUntil:'domcontentloaded'});
    return page.evaluate(base=>{
      const header=document.querySelector('#info_block');
      if(!header)return null;
      const links=[...header.querySelectorAll('a')].flatMap(a=>{
        try{const u=new URL(a.getAttribute('href')??'',base);return u.origin===new URL(base).origin?[u]:[];}catch{return [];}
      });
      return {text:header.textContent.trim(),logout:links.some(u=>u.pathname==='/logout.php'),
        userIds:[...new Set(links.filter(u=>u.pathname==='/userdetails.php'&&[...u.searchParams.keys()].every(k=>k==='id'))
          .map(u=>u.searchParams.get('id')).filter(id=>/^\d{1,20}$/.test(id??'')))]};
    },url);
  });
  const read=async url=>{
    const response=await context.request.get(url,{timeout:15000,maxRedirects:0,headers:{'Cache-Control':'no-cache'}});
    if(response.status()!==200||response.url()!==url)return null;
    const date=Date.parse(response.headers().date??'');
    if(!Number.isFinite(date)||new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(new Date(date))!==
      new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(now))return null;
    return snapshot(await response.text(),url);
  };
  const unknown=()=>({status:'unknown',failureCode:'authoritative_status_unavailable',submissionAttempted:false});
  try{
    const index=await read(origin+'/index.php');
    if(!index?.logout||index.userIds.length!==1)return unknown();
    const profile=await read(origin+'/userdetails.php?id='+index.userIds[0]);
    if(!profile?.logout||profile.userIds.length!==1||profile.userIds[0]!==index.userIds[0])return unknown();
    const signed=/(?:^|[\s(（])签到已得[0-9,.]+(?:$|[\s)）])/.test(profile.text)&&
      !/(?:历史|歷史|累计|累計|昨日|昨天).{0,16}签到已得/.test(profile.text);
    if(!signed)return unknown();
    return {status:'already_signed',submissionAttempted:false,evidence:{source:'pt_page',authoritative:true,
      confirmedAt:now.toISOString(),businessDate:new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(now),
      pagePath:'/userdetails.php',statusSignal:'ourbits_self_profile_signed'}};
  }finally{await page?.close().catch(()=>{});}
}
