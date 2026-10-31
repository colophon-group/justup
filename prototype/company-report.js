'use strict';

// Builds fictional company reports from listing history shared with the feed and news ribbon.
// Read when changing report figures, salary summaries or charts.
const companyReportHistory=new Map();
const reportDAY=86400000;
const reportRoleNames={engineering:'Engineering',robotics:'Robotics',design:'Design',data:'Data & AI',product:'Product',operations:'Operations',marketing:'Marketing'};
const reportSalaryBands={CHE:['CHF',135000,165000],DEU:['EUR',95000,125000],AUT:['EUR',85000,110000],USA:['USD',140000,180000],CAN:['CAD',120000,160000],GBR:['GBP',85000,110000],JPN:['JPY',10000000,15000000],AUS:['AUD',130000,175000],BRA:['BRL',180000,260000],ZAF:['ZAR',800000,1100000],MEX:['MXN',900000,1300000],CHL:['CLP',36000000,52000000],SGP:['SGD',120000,165000],IND:['INR',2800000,4200000],IDN:['IDR',360000000,540000000],KEN:['KES',3000000,4500000],NGA:['NGN',18000000,28000000],EGY:['EGP',480000,720000],NZL:['NZD',120000,155000],DNK:['DKK',650000,850000],SWE:['SEK',650000,850000],FRA:['EUR',80000,110000],NLD:['EUR',85000,110000],NOR:['NOK',850000,1100000],FIN:['EUR',75000,100000]};
let disposeReportChart;
const reportState={company:null,range:90,currency:null};
const reportT=s=>I18n.text(s);
const reportN=n=>new Intl.NumberFormat(I18n.locale).format(n);
const reportDate=(date,year=false)=>new Intl.DateTimeFormat(I18n.locale,{day:'numeric',month:'short',...(year?{year:'numeric'}:{})}).format(date);

function reportAllocate(total,seed){
  const result=Array(7).fill(Math.floor(total/7));
  for(let i=0;i<total%7;i++)result[(i*3+seed)%7]++;
  return result;
}
function initializeCompanyReports(){
  for(const [index,c]of baseCompanies.entries()){
    const seed=[...c.id].reduce((n,ch)=>n+ch.charCodeAt(0),0);
    const snapshot=wireSnapshots.find(s=>s.company===c.id);
    const existing=jobs.filter(j=>j.company===c.id);
    const current=snapshot?snapshot.daily:reportAllocate(Math.round(existing.length*(.37+(index%4)*.09)),seed);
    const previous=reportAllocate(snapshot?snapshot.previous:existing.length-current.reduce((a,b)=>a+b,0),seed+1);
    const recent=[...previous,...current];
    const required=recent.reduce((a,b)=>a+b,0);
    while(existing.length<required){
      const template=existing[existing.length%32]||jobs.find(j=>j.company===c.id);
      if(!template)break;
      const job={...template,id:`report-${c.id}-${existing.length}`,isNew:false};
      jobs.push(job);existing.push(job);
    }
    let cursor=0;
    recent.forEach((count,day)=>{
      for(let n=0;n<count;n++){
        const job=existing[cursor++];if(!job)continue;
        job.firstObserved=now-(13-day+(n+1)/(count+1)*.8)*reportDAY;
      }
    });
    existing.forEach((job,n)=>{
      const band=reportSalaryBands[job.country];
      if(!band||n%5===0){job.reportSalary=null;job.salary='Salary not listed';return;}
      const factor={mid:.85,senior:1,staff:1.16,manager:1.2}[job.level]||1;
      job.reportSalary={currency:band[0],min:Math.round(band[1]*factor/1000)*1000,max:Math.round(band[2]*factor/1000)*1000,period:'year'};
      job.salary=reportSalaryLabel(job.reportSalary);
    });
    const age=160+seed%160;
    const daily=Array.from({length:400},(_,i)=>{
      const ago=399-i;
      if(ago>=age)return null;
      if(c.status==='configuring')return null;
      if(c.status==='attention'&&ago<3)return null;
      if(ago<14&&c.status==='monitoring')return recent[13-ago];
      const wave=Math.sin((i+seed)*.14)+Math.sin((i+seed)*.047)*.8;
      const baseline=Math.max(1,(snapshot?snapshot.previous:15)/7);
      return Math.max(0,Math.round(baseline*(.65+(i/400)*.3)+wave*1.2+(seed+i*13)%5*.35));
    });
    companyReportHistory.set(c.id,{seed,age,daily,since:new Date(now-(age-1)*reportDAY)});
  }
  jobs.sort((a,b)=>b.firstObserved-a.firstObserved);
}
function reportSalaryLabel(s){
  const compact=n=>new Intl.NumberFormat('en',{notation:'compact',maximumFractionDigits:1}).format(n).toLowerCase();
  return `${s.currency} ${compact(s.min)}–${compact(s.max)}`;
}
function companyReport(c){
  const history=companyReportHistory.get(c.id);
  const cutoff=Date.now()-14*reportDAY;
  const recent=jobs.filter(j=>j.company===c.id&&j.firstObserved>=cutoff).sort((a,b)=>b.firstObserved-a.firstObserved);
  const weekly=recent.filter(j=>j.firstObserved>=Date.now()-7*reportDAY).length;
  const previous=recent.length-weekly;
  const comparable=c.status==='monitoring'&&!!history;
  const change=comparable&&previous>0?Math.round((weekly-previous)/previous*100):null;
  const daily=history?[...history.daily]:[];
  if(c.status==='monitoring')for(let ago=0;ago<14;ago++)daily[399-ago]=recent.filter(j=>Math.floor((now-j.firstObserved)/reportDAY)===ago).length;
  const roleCounts=new Map(),levelCounts=new Map(),workplaces=new Map(),countries=new Map(),skills=new Map();
  for(const j of recent){
    roleCounts.set(j.category,(roleCounts.get(j.category)||0)+1);
    levelCounts.set(j.level,(levelCounts.get(j.level)||0)+1);
    workplaces.set(j.workplace,(workplaces.get(j.workplace)||0)+1);
    countries.set(j.country,(countries.get(j.country)||0)+1);
    for(const skill of j.skills.split(' · '))skills.set(skill,(skills.get(skill)||0)+1);
  }
  const salaryGroups=new Map();
  for(const j of recent)if(j.reportSalary){const currency=j.reportSalary.currency;if(!salaryGroups.has(currency))salaryGroups.set(currency,[]);salaryGroups.get(currency).push(j);}
  return{history,daily,recent,weekly,previous,change,comparable,roleCounts,levelCounts,workplaces,countries,skills,salaryGroups,salaryCount:[...salaryGroups.values()].flat().length};
}
function reportChangeHTML(data){
  if(!data.comparable)return `<span class="report-change">${reportT('Comparison paused')}</span>`;
  if(data.change===null)return `<span class="report-change">${reportT('No previous-week baseline')}</span>`;
  return `<span class="report-change${data.change<0?' is-down':''}"><span aria-hidden="true">${data.change>0?'↗':data.change<0?'↘':'→'}</span> ${data.change>0?'+':data.change<0?'−':''}${Math.abs(data.change)}%</span><span class="report-comparison">${reportT('vs previous 7 days')}</span>`;
}
function reportMetric(label,value,note){return `<div class="report-metric"><span class="eyebrow">${reportT(label)}</span><strong>${value}</strong><span>${note}</span></div>`;}
function companyReportHTML(c){
  const data=companyReport(c),pending=c.status==='configuring',stale=c.status==='attention';
  if(reportState.company!==c.id){reportState.company=c.id;reportState.range=90;reportState.currency=null;}
  const count=data.recent.length;
  const sourceMeta=data.history&&!pending?`${reportT('On record since')} ${reportDate(data.history.since,true)}`:reportT('First report incoming');
  return `<a class="back" href="#jobs">← ${reportT('Back to search')}</a>
  <header class="report-masthead"><div class="report-identity"><span class="eyebrow">${reportT('THE HIRING REPORT')}</span><div class="detail-heading"><h1 data-no-translate>${escapeHTML(c.name)}</h1></div><div class="company-subtitle">${mark(c)}<span>${escapeHTML(c.industry)}</span></div><p class="report-description" data-no-translate>${escapeHTML(c.description)}</p></div><div class="report-identity-aside"><span class="report-edition">${reportT('Company file')} / ${String(Math.max(0,baseCompanies.findIndex(b=>b.id===c.id))+1).padStart(3,'0')}</span><div class="report-header-actions">${followButtonHTML(c)}${pending?`<button class="button dark" data-priority="${c.id}">${reportT(requests.some(r=>r.company===c.id)?'Priority requested ✓':'Request priority')} ↑</button>`:`<button class="button dark" data-search-company="${c.id}">${reportT('See positions')} ↗</button>`}</div><span class="report-since">${sourceMeta}</span></div></header>
  ${pending?reportPendingHTML(c):`
  <section class="report-market" aria-labelledby="report-activity-title"><div class="report-quote"><div class="report-quote-main"><span class="eyebrow">${reportT('NEW LISTINGS / LAST 7 DAYS')}</span><div class="report-quote-line"><strong>${stale?'—':reportN(data.weekly)}</strong><div class="report-delta">${reportChangeHTML(data)}</div></div><p>${reportT(stale?'Updates delayed':'New at the source.')}</p></div><div class="report-ranges" role="group" aria-label="${reportT('History range')}">${[[28,'4W'],[90,'3M'],[365,'1Y']].map(([n,label])=>`<button data-report-range="${n}" aria-pressed="${reportState.range===n}">${label}</button>`).join('')}</div></div>
  <div class="report-chart-paper"><div class="report-chart-heading"><h2 id="report-activity-title">${reportT('The hiring tape.')}</h2><div class="report-chart-readout"><span data-chart-date>${reportDate(now)}</span><strong data-chart-value>${stale?'—':reportN(data.weekly)}</strong><span>${reportT('new / 7 days')}</span></div></div><div id="report-chart" class="report-chart"></div><div class="report-chart-caption"><span>${reportT('Line: 7-day listing volume')}</span><span>${reportT('Bars: new listings per day')}</span></div></div></section>
  <section class="report-metrics" aria-label="${reportT('Listing snapshot')}">${reportMetric('LAST 14 DAYS',stale?'—':reportN(count),reportT('new listings observed'))}${reportMetric('SALARY DISCLOSURE',count?`${Math.round(data.salaryCount/count*100)}<small>%</small>`:'—',count?`${reportN(data.salaryCount)} / ${reportN(count)} ${reportT('listings report pay')}`:reportT('No recent sample'))}${reportMetric('REMOTE ROLES',count?`${Math.round((data.workplaces.get('Remote')||0)/count*100)}<small>%</small>`:'—',reportT('of recent listings'))}${reportMetric('HIRING IN',count?reportN(data.countries.size):'—',reportT('countries in job listings'))}</section>
  <div class="report-analysis-grid"><section class="report-roles report-section"><div class="report-section-heading"><span class="eyebrow">${reportT('THE ROLE MIX')}</span><span class="report-period">${reportT('Last 14 days')}</span></div><h2>${reportT('Where the demand is.')}</h2>${reportRolesHTML(data)}<div class="report-levels"><span class="eyebrow">${reportT('EXPERIENCE MIX')}</span><div>${[...data.levelCounts].sort((a,b)=>b[1]-a[1]).map(([level,n])=>`<span><b>${reportT({mid:'Mid-level',senior:'Senior',staff:'Staff',manager:'Management'}[level]||level)}</b> ${Math.round(n/Math.max(1,count)*100)}%</span>`).join('')||`<span>${reportT('No recent sample')}</span>`}</div></div></section>
  <section class="report-pay report-section"><div class="report-section-heading"><span class="eyebrow">${reportT('REPORTED SALARIES')}</span><span class="report-period">${reportT('Annual base pay')}</span></div><h2>${reportT('The pay on paper.')}</h2><div class="report-currencies" role="group" aria-label="${reportT('Salary currency')}">${[...data.salaryGroups].sort((a,b)=>b[1].length-a[1].length).map(([currency],i)=>`<button data-report-currency="${currency}" aria-pressed="${reportState.currency?reportState.currency===currency:i===0}" data-no-translate>${currency}</button>`).join('')}</div><div id="report-salary-ranges"></div><p class="report-salary-note">${reportT('Published ranges only. No estimates.')}</p></section></div>
  <div class="report-bottom-grid"><section class="report-footprint report-section"><div class="report-section-heading"><span class="eyebrow">${reportT('THE HIRING FOOTPRINT')}</span></div><h2>${reportT('Where the roles are.')}</h2><div class="report-footprint-body"><div class="company-map" data-map-company="${c.id}" aria-hidden="true"></div><div class="report-country-list">${[...data.countries].sort((a,b)=>b[1]-a[1]).slice(0,5).map(([code,n])=>`<div><span>${reportT(countryData[code]?.name||code)}</span><b>${reportN(n)}</b></div>`).join('')||`<p>${reportT('No recent sample')}</p>`}</div></div></section>
  <section class="report-notebook report-section"><span class="eyebrow">${reportT('FROM THE LISTINGS')}</span><h2>${reportT('Worth a closer look.')}</h2><div class="report-notebook-row"><span>${reportT('Workplace mix')}</span><div class="report-workplace-bar" aria-hidden="true">${['Remote','Hybrid','On-site'].map((name,i)=>`<i style="flex:${data.workplaces.get(name)||0};--segment:${i}"></i>`).join('')}</div><div class="report-workplace-key">${['Remote','Hybrid','On-site'].map((name,i)=>`<span><i data-workplace="${i}" style="--segment:${i}"></i>${reportT(name)} <b>${count?Math.round((data.workplaces.get(name)||0)/count*100):'—'}${count?'%':''}</b></span>`).join('')}</div></div><div class="report-notebook-row"><span>${reportT('Skills in demand')}</span><div class="report-skills">${[...data.skills].sort((a,b)=>b[1]-a[1]).slice(0,5).map(([skill,n])=>`<span data-no-translate>${escapeHTML(skill)} <b>${reportN(n)}</b></span>`).join('')||reportT('No recent sample')}</div></div><p class="report-source-scope">${reportT('Based on observed job listings.')}</p></section></div>`}
  <section class="report-record"><div><span class="eyebrow">${reportT('ON THE RECORD')}</span><h2>${reportT('Check the sources.')}</h2><p>${reportT(pending?'We’re preparing the first company report.':'Every figure starts with a company career page.')}</p></div><div class="report-record-sources">${careerLinksHTML(c)}${stale?`<p class="report-coverage-warning">${reportT('Updates are delayed. Comparisons resume when coverage returns.')}</p>`:''}<a class="report-request" href="#request">${reportT('Missing a company?')} <b>${reportT('Send us a lead')} ↗</b></a></div></section>`;
}
function reportPendingHTML(c){return `<section class="report-pending"><span class="report-pending-mark" aria-hidden="true">↗</span><div><span class="eyebrow">${reportT('ON OUR RADAR')}</span><h2>${reportT('First report incoming.')}</h2><p>${reportT('The company is in the catalogue. Its hiring history starts when we begin checking the career pages.')}</p><button class="text-link" data-priority="${c.id}">${reportT(requests.some(r=>r.company===c.id)?'Priority requested ✓':'Request higher priority ↑')}</button></div></section>`;}
function reportRolesHTML(data){
  const sorted=[...data.roleCounts].sort((a,b)=>b[1]-a[1]),max=sorted[0]?.[1]||1;
  if(!sorted.length)return `<p class="report-empty">${reportT('No recent sample')}</p>`;
  return `<div class="report-role-list">${sorted.map(([key,n],i)=>`<div class="report-role-row"><span class="report-rank">${String(i+1).padStart(2,'0')}</span><div><span>${reportT(reportRoleNames[key]||key)}</span><i style="--share:${n/max*100}%"></i></div><b>${reportN(n)}</b></div>`).join('')}</div>`;
}
function paintReportSalaries(c){
  const host=$('#report-salary-ranges');if(!host)return;
  const data=companyReport(c),currencies=[...data.salaryGroups].sort((a,b)=>b[1].length-a[1].length);
  if(!currencies.length){host.innerHTML=`<p class="report-empty">${reportT('No reported salary ranges yet.')}</p>`;return;}
  const currency=currencies.some(([key])=>key===reportState.currency)?reportState.currency:currencies[0][0];reportState.currency=currency;
  const sample=data.salaryGroups.get(currency);
  const unique=new Map();for(const job of sample){const key=job.category;const row=unique.get(key)||{key,min:Infinity,max:0,count:0};row.min=Math.min(row.min,job.reportSalary.min);row.max=Math.max(row.max,job.reportSalary.max);row.count++;unique.set(key,row);}
  const rows=[...unique.values()].sort((a,b)=>b.count-a.count).slice(0,7),minimum=Math.min(...rows.map(r=>r.min)),maximum=Math.max(...rows.map(r=>r.max)),span=Math.max(1,maximum-minimum);
  host.innerHTML=`<div class="report-pay-sample"><strong>${reportN(sample.length)}</strong><span>${reportT('salary disclosures')}</span></div><div class="report-pay-rows">${rows.map(r=>`<div class="report-pay-row"><div><span>${reportT(reportRoleNames[r.key]||r.key)}</span><b data-no-translate>${reportSalaryLabel({...r,currency}).replace(currency+' ','')}</b></div><div class="report-pay-track"><i style="left:${(r.min-minimum)/span*100}%;width:${Math.max(2,(r.max-r.min)/span*100)}%"></i></div></div>`).join('')}</div>`;
  for(const button of $$('[data-report-currency]'))button.setAttribute('aria-pressed',String(button.dataset.reportCurrency===currency));
}
function paintReportChart(c){
  disposeReportChart?.();disposeReportChart=null;const host=$('#report-chart');if(!host)return;
  const data=companyReport(c),range=reportState.range,daily=data.daily;
  const points=Array.from({length:range},(_,i)=>{
    const index=400-range+i,part=daily.slice(Math.max(0,index-6),index+1);
    return{date:new Date(now-(range-1-i)*reportDAY),daily:daily[index]??null,value:part.length===7&&part.every(n=>n!==null&&n!==undefined)?part.reduce((a,b)=>a+b,0):null};
  });
  const mobile=matchMedia('(max-width:720px)').matches;
  const W=mobile?560:1080,H=302,left=10,right=mobile?42:57,top=17,bottom=222,barTop=249,barBottom=276;
  const available=points.filter(p=>p.value!==null),high=Math.max(10,...available.map(p=>p.value)),tick=Math.max(5,Math.ceil(high/4/5)*5),ceiling=tick*4;
  const x=i=>left+i/(range-1)*(W-left-right),y=n=>bottom-n/ceiling*(bottom-top);
  let line='',area='',started=false,segment=[];const areas=[];
  for(let i=0;i<points.length;i++){
    const p=points[i];if(p.value===null){if(segment.length){areas.push(segment);segment=[];}started=false;continue;}
    line+=`${started?'L':'M'}${x(i).toFixed(2)},${y(p.value).toFixed(2)} `;segment.push([x(i),y(p.value)]);started=true;
  }
  if(segment.length)areas.push(segment);
  for(const path of areas)area+=`M${path[0][0]},${bottom} ${path.map(([px,py])=>`L${px},${py}`).join(' ')} L${path.at(-1)[0]},${bottom} Z `;
  const maxDaily=Math.max(1,...points.map(p=>p.daily||0)),barWidth=Math.max(1,(W-left-right)/range*.6);
  const grid=Array.from({length:5},(_,i)=>{const v=tick*i;return `<line x1="${left}" x2="${W-right}" y1="${y(v)}" y2="${y(v)}" class="report-chart-grid"/><text x="${W-right+13}" y="${y(v)+4}" class="report-axis">${reportN(v)}</text>`;}).join('');
  const dateTicks=[0,Math.round((range-1)/3),Math.round((range-1)*2/3),range-1].map((i,j)=>`<text x="${x(i)}" y="${H-5}" text-anchor="${j===0?'start':j===3?'end':'middle'}" class="report-axis">${reportDate(points[i].date)}</text>`).join('');
  const bars=points.map((p,i)=>p.daily===null?'':`<rect x="${x(i)-barWidth/2}" y="${barBottom-(p.daily/maxDaily)*(barBottom-barTop)}" width="${barWidth}" height="${Math.max(1,(p.daily/maxDaily)*(barBottom-barTop))}" class="report-volume-bar"/>`).join('');
  const first=points.findIndex(p=>p.value!==null),last=points.findLastIndex(p=>p.value!==null);
  const latest=last>=0?`<circle cx="${x(last)}" cy="${y(points[last].value)}" r="4" class="report-latest"/>`:'';
  const gap=first>4?`<text x="${x(Math.floor(first/2))}" y="130" text-anchor="middle" class="report-gap-label">${reportT('Before we started watching')}</text>`:'';
  host.innerHTML=`<svg viewBox="0 0 ${W} ${H}" tabindex="0" role="group" aria-label="${reportT('New listing history. Use arrow keys to inspect dates.')}" aria-keyshortcuts="ArrowLeft ArrowRight Home End"><defs><linearGradient id="report-plot-fill" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="var(--cream)" stop-opacity=".9"/><stop offset="1" stop-color="var(--cream)" stop-opacity=".05"/></linearGradient></defs>${grid}${gap}<path d="${area}" fill="url(#report-plot-fill)"/><path d="${line}" class="report-price-line"/>${latest}${bars}${dateTicks}<g class="report-crosshair" hidden><line y1="${top}" y2="${barBottom}"/><circle r="4"/></g><rect x="${left}" y="0" width="${W-left-right}" height="${barBottom}" fill="transparent" class="report-chart-hit"/></svg>`;
  const svg=$('svg',host),cross=$('.report-crosshair',host);let selected=range-1;
  function show(index,keyboard=false){selected=Math.max(0,Math.min(range-1,index));const point=points[selected];$('[data-chart-date]').textContent=reportDate(point.date);$('[data-chart-value]').textContent=point.value===null?'—':reportN(point.value);cross.toggleAttribute('hidden',point.value===null);if(point.value!==null){$('line',cross).setAttribute('x1',x(selected));$('line',cross).setAttribute('x2',x(selected));$('circle',cross).setAttribute('cx',x(selected));$('circle',cross).setAttribute('cy',y(point.value));}if(keyboard)announce(`${reportDate(point.date,true)}: ${point.value===null?reportT('No coverage'):reportN(point.value)+' '+reportT('new / 7 days')}`);}
  svg.addEventListener('pointermove',event=>{const bounds=svg.getBoundingClientRect();show(Math.round(((event.clientX-bounds.left)/bounds.width*W-left)/(W-left-right)*(range-1)));});
  svg.addEventListener('pointerleave',()=>{show(range-1);cross.setAttribute('hidden','');});
  svg.addEventListener('keydown',event=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();show(event.key==='Home'?0:event.key==='End'?range-1:selected+(event.key==='ArrowLeft'?-1:1),true);});
  svg.addEventListener('blur',()=>{show(range-1);cross.setAttribute('hidden','');});
  show(range-1);cross.setAttribute('hidden','');
  const observer=new ResizeObserver(()=>{if(host.isConnected&&matchMedia('(max-width:720px)').matches!==mobile)paintReportChart(c);});observer.observe(host);disposeReportChart=()=>observer.disconnect();
}
function mountCompanyReport(c){paintReportChart(c);paintReportSalaries(c);if(c.status!=='configuring')paintCompanyMap(c);}
document.addEventListener('click',event=>{
  const range=event.target.closest('[data-report-range]');
  if(range){reportState.range=Number(range.dataset.reportRange);for(const button of $$('[data-report-range]'))button.setAttribute('aria-pressed',String(button===range));paintReportChart(companyFor(reportState.company));}
  const currency=event.target.closest('[data-report-currency]');
  if(currency){reportState.currency=currency.dataset.reportCurrency;paintReportSalaries(companyFor(reportState.company));}
});
