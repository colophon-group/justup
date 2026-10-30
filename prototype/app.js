'use strict';
const $ = (q, root=document) => root.querySelector(q);
const $$ = (q, root=document) => [...root.querySelectorAll(q)];
const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const sleep = ms => new Promise(resolve => setTimeout(resolve,ms));
const STORAGE='justup-prototype-v1';
let saved={}; try { saved=JSON.parse(localStorage.getItem(STORAGE)||'{}'); } catch {}
const baseCompanies=[
['northline','Northline','northline.example','Robotics & automation','Zurich, Switzerland','Autonomous systems for a world that keeps moving.','N','monitoring',true],
['formwork','Formwork','formwork.example','Developer tools','Zurich, Switzerland','Tools that make building software feel straightforward.','ƒ','monitoring',false],
['orbit','Orbit','orbit.example','Cloud infrastructure','San Francisco, United States','Reliable infrastructure for ambitious engineering teams.','O','monitoring',true],
['fieldwork','Fieldwork','fieldwork.example','Climate technology','São Paulo, Brazil','Software and sensors for healthier land and better harvests.','F','monitoring',false],
['parcel','Parcel','parcel.example','Commerce & logistics','Singapore','Making the movement of goods simpler and more sustainable.','P','monitoring',true],
['goodlight','Goodlight','goodlight.example','Energy','Cape Town, South Africa','Building an energy system that works for everyone.','g','monitoring',false],
['relay','Relay','relay.example','Financial technology','Zurich, Switzerland','The financial layer for businesses with global ambitions.','R','monitoring',true],
['still','Still','still.example','Health technology','Sydney, Australia','Better digital tools for the people delivering care.','s','monitoring',false],
['atelier','Atelier','atelier.example','Design & collaboration','Copenhagen, Denmark','A shared workspace for people who make things.','A','monitoring',true],
['latitude','Latitude','latitude.example','Travel technology','Amsterdam, Netherlands','Helping people find their way to somewhere new.','L','monitoring',false],
['common','Common','common.example','Developer tools','Berlin, Germany','Useful infrastructure, built around the people using it.','c','monitoring',true],
['kinetic','Kinetic','kinetic.example','Robotics & automation','Munich, Germany','Machines that work alongside people, wherever work happens.','K','monitoring',false],
['arc','Arc Systems','arcsystems.example','Cloud infrastructure','London, United Kingdom','A stronger foundation for the next generation of software.','↗','monitoring',true],
['sprout','Sprout','sprout.example','Climate technology','Stockholm, Sweden','Making lower-impact living easier to choose.','S','monitoring',false],
['weave','Weave','weave.example','Artificial intelligence','Zurich, Switzerland','Practical intelligence woven into everyday work.','w','monitoring',true],
['meridian','Meridian','meridian.example','Robotics & automation','Zurich, Switzerland','Precision robotics for industry and research.','M','configuring',false],
['tandem','Tandem','tandem.example','Climate technology','Berlin, Germany','A new generation of shared mobility.','t','configuring',true],
['clearwater','Clearwater','clearwater.example','Health technology','Basel, Switzerland','Connecting research teams to better clinical insights.','C','configuring',false],
['folio','Folio','folio.example','Design & collaboration','Paris, France','A home for creative work and the people behind it.','f','attention',true],
['openwater','Openwater','openwater.example','Energy','Oslo, Norway','Technology for cleaner seas and coastal energy.','o','attention',false]
].map(([id,name,domain,industry,location,description,mark,status,light],i)=>({id,name,domain,industry,location,description,mark,status,light,careerPages:status==='configuring'?[]:i%3===0?[{url:'https://'+domain+'/careers'}]:[{url:'https://'+domain+'/careers/locations'},{url:'https://'+domain+'/careers/remote'}],scope: i%3===0?'Global career page':'European career pages',check:status==='attention'?'7 h ago':`${3+i%9} min ago`,issue:status==='attention'?'This company’s career page has changed. We’re working on getting job updates back.':null}));
let companies=[...baseCompanies,...(saved.addedCompanies||[])];
companies=companies.map(c=>c.demo?{...c,description:`${c.name} is a sample company in this demo.`,scope:'Career pages not confirmed yet'}:c);
let requests=(saved.requests||[]).map(r=>r.priority==='Standard queue'?{...r,priority:'Standard request'}:r);
let viewed=new Set(saved.viewed||[]);
let premium=saved.premium!==false;
let searches=saved.searches?.length ? saved.searches : [
{id:'backend',title:'Backend · Switzerland',query:'Senior backend roles in Zurich, or remote from Switzerland. Go required.',criteria:'Senior backend · Zurich or remote from Switzerland · Go required'},
{id:'robotics',title:'Robotics · Europe',query:'Robotics and autonomy roles in Europe.',criteria:'Robotics & autonomy · Europe'},
{id:'everything',title:'Everything fresh',query:'All fresh positions.',criteria:'All roles · All locations · First seen in the last 14 days'}];
let activeSearch=searches.some(s=>s.id===saved.activeSearch)?saved.activeSearch:searches[0].id;
let motion=saved.motion||'ink', forcedReduced=false;
let queryTimer=0,requestGeneration=0,requestDraft='',companyFilter='all',toastTimer;
const now=Date.now();
const roles=[
['Senior Backend Engineer','engineering','Go · PostgreSQL','Zurich, Switzerland','Hybrid','CHF 135–165k','senior'],
['Backend Engineer, Platform','engineering','Go · Kubernetes','Remote, Switzerland','Remote','CHF 120–155k','mid'],
['Staff Software Engineer','engineering','Go · Distributed systems','Zurich, Switzerland','Hybrid','CHF 160–190k','staff'],
['Senior Platform Engineer','engineering','Go · Terraform','Remote, Switzerland','Remote','CHF 140–170k','senior'],
['Backend Engineer, Payments','engineering','Go · gRPC','Zurich, Switzerland','Hybrid','CHF 130–160k','senior'],
['Senior Software Engineer, Infrastructure','engineering','Go · Linux','Remote, Switzerland','Remote','CHF 135–175k','senior'],
['Robotics Software Engineer','robotics','C++ · ROS 2','Zurich, Switzerland','On-site','CHF 115–145k','mid'],
['Senior Autonomy Engineer','robotics','C++ · Python','Munich, Germany','Hybrid','€95–125k','senior'],
['Robotics Controls Engineer','robotics','C++ · Control systems','Zurich, Switzerland','On-site','CHF 120–150k','senior'],
['Perception Engineer','robotics','Python · Computer vision','Berlin, Germany','Hybrid','€85–115k','mid'],
['Product Designer','design','Figma · Design systems','Copenhagen, Denmark','Hybrid','€75–95k','mid'],
['Senior Product Designer','design','Research · Prototyping','Remote, Europe','Remote','€85–110k','senior'],
['Frontend Engineer','engineering','TypeScript · React','Amsterdam, Netherlands','Hybrid','€85–110k','mid'],
['Machine Learning Engineer','data','Python · PyTorch','Zurich, Switzerland','Hybrid','CHF 130–165k','senior'],
['Data Engineer','data','Python · SQL','Berlin, Germany','Hybrid','€80–105k','mid'],
['Product Manager','product','B2B SaaS · Strategy','London, United Kingdom','Hybrid','£85–110k','senior'],
['Customer Success Manager','operations','Customer strategy · SaaS','Remote, Europe','Remote','€65–85k','mid'],
['Senior Backend Engineer','engineering','Go · AWS','Lausanne, Switzerland','Hybrid','CHF 130–160k','senior'],
['Developer Advocate','engineering','Go · Technical writing','Remote, Europe','Remote','€90–115k','senior'],
['Security Engineer','engineering','Cloud security · Go','Bern, Switzerland','Hybrid','CHF 125–155k','senior'],
['Growth Marketing Lead','marketing','Analytics · Lifecycle','Remote, Europe','Remote','€75–100k','senior'],
['Engineering Manager','engineering','People leadership · Go','Zurich, Switzerland','Hybrid','CHF 165–195k','manager'],
['Research Engineer, Manipulation','robotics','Python · Robot learning','Munich, Germany','On-site','€85–115k','mid'],
['Senior Backend Engineer, API','engineering','Go · PostgreSQL','Remote, Switzerland','Remote','CHF 135–170k','senior']
];
const countryData={
CHE:{name:'Switzerland',city:'Zurich',region:'Europe',salary:'CHF 135–165k'},
DEU:{name:'Germany',city:'Berlin',region:'Europe',salary:'€95–125k'},
AUT:{name:'Austria',city:'Vienna',region:'Europe',salary:'€85–110k'},
USA:{name:'United States',city:'New York',region:'North America',salary:'$140–180k'},
CAN:{name:'Canada',city:'Toronto',region:'North America',salary:'C$120–160k'},
GBR:{name:'United Kingdom',city:'London',region:'Europe',salary:'£85–110k'},
JPN:{name:'Japan',city:'Tokyo',region:'Asia',salary:'¥10–15m'},
AUS:{name:'Australia',city:'Sydney',region:'Oceania',salary:'A$130–175k'},
BRA:{name:'Brazil',city:'São Paulo',region:'South America',salary:'R$180–260k'},
ZAF:{name:'South Africa',city:'Cape Town',region:'Africa',salary:'R800k–1.1m'},
MEX:{name:'Mexico',city:'Mexico City',region:'North America',salary:'MX$900k–1.3m'},
CHL:{name:'Chile',city:'Santiago',region:'South America',salary:'CLP 36–52m'},
ARG:{name:'Argentina',city:'Buenos Aires',region:'South America',salary:'Salary not listed'},
SGP:{name:'Singapore',city:'Singapore',region:'Asia',salary:'S$120–165k'},
IND:{name:'India',city:'Bengaluru',region:'Asia',salary:'₹28–42L'},
IDN:{name:'Indonesia',city:'Jakarta',region:'Asia',salary:'Rp360–540m'},
KEN:{name:'Kenya',city:'Nairobi',region:'Africa',salary:'KSh3–4.5m'},
NGA:{name:'Nigeria',city:'Lagos',region:'Africa',salary:'₦18–28m'},
EGY:{name:'Egypt',city:'Cairo',region:'Africa',salary:'E£480–720k'},
NZL:{name:'New Zealand',city:'Auckland',region:'Oceania',salary:'NZ$120–155k'},
DNK:{name:'Denmark',city:'Copenhagen',region:'Europe',salary:'DKK650–850k'},
SWE:{name:'Sweden',city:'Stockholm',region:'Europe',salary:'SEK650–850k'},
FRA:{name:'France',city:'Paris',region:'Europe',salary:'€80–110k'},
NLD:{name:'Netherlands',city:'Amsterdam',region:'Europe',salary:'€85–110k'},
NOR:{name:'Norway',city:'Oslo',region:'Europe',salary:'NOK850k–1.1m'},
FIN:{name:'Finland',city:'Helsinki',region:'Europe',salary:'€75–100k'}
};
// Distinct fictional hiring footprints exercise regional and worldwide map views.
const hiringFootprints={
northline:['CHE','CHE','CHE','DEU','AUT'],formwork:['USA','CAN','GBR','DEU','JPN','AUS','BRA','ZAF'],
orbit:['USA','CAN'],fieldwork:['BRA','MEX','CHL','ARG'],parcel:['SGP','JPN','IND','IDN'],
goodlight:['ZAF','KEN','NGA','EGY'],relay:['CHE','CHE','USA','GBR'],still:['AUS','NZL'],
atelier:['DNK','SWE','FRA'],latitude:['NLD','SGP','AUS','JPN'],common:['DEU','FRA','GBR'],
kinetic:['DEU','DEU','CHE','AUT'],arc:['GBR','USA','CAN'],sprout:['SWE','NOR','FIN','DNK'],weave:['CHE','CHE','SGP','USA']
};
const companyJobCounts={};
const jobs=Array.from({length:480},(_,i)=>{
const [title,category,skills,,workplace,,level]=roles[i%roles.length];
const eligible=baseCompanies.filter(c=>c.status==='monitoring');
const company=eligible[(i*7+Math.floor(i/roles.length))%eligible.length];
const sequence=companyJobCounts[company.id]||0;companyJobCounts[company.id]=sequence+1;
const footprint=hiringFootprints[company.id];const country=footprint[sequence%footprint.length];const place=countryData[country];
const location=workplace==='Remote'?`Remote, ${place.name}`:`${place.city}, ${place.name}`;
return{id:`job-${i}`,title,category,skills,location,country,workplace,salary:place.salary,level,company:company.id,type:i%29===0?'Contract':'Permanent',firstObserved:now-(120000+i*40*60000),isNew:false};
});
// The prototype uses no APIs. Matching, discovery, continuations and live events are local simulations.
function persist(){try{localStorage.setItem(STORAGE,JSON.stringify({searches,activeSearch,viewed:[...viewed],requests,addedCompanies:companies.filter(c=>!baseCompanies.some(b=>b.id===c.id)),premium,motion}));}catch{}}
function announce(text){$('#announcer').textContent=text;}
function toast(message){clearTimeout(toastTimer);$('#toast').textContent=message;$('#toast').hidden=false;toastTimer=setTimeout(()=>$('#toast').hidden=true,3300);}
function companyFor(id){return companies.find(c=>c.id===id);}
function mark(c){return `<span class="mark ${c.light?'light':''}" aria-hidden="true">${escapeHTML(c.mark)}</span>`;}
function age(job){const mins=Math.max(0,Math.floor((Date.now()-job.firstObserved)/60000));return mins<1?'now':mins<60?`${mins}m`:mins<1440?`${Math.floor(mins/60)}h`:`${Math.floor(mins/1440)}d`;}
function fullTime(job){return `First seen on Justup ${new Date(job.firstObserved).toLocaleString('en-GB')}`;}
function postingURL(job){const c=companyFor(job.company);return 'sample-posting.html?'+new URLSearchParams({title:job.title,company:c.name,location:job.location,skills:job.skills,salary:job.salary}).toString();}
const eye='<svg class="viewed-icon" viewBox="0 0 20 14" fill="none" stroke="currentColor" stroke-width="1.5" role="img" aria-label="Viewed"><path d="M1 7s3-5 9-5 9 5 9 5-3 5-9 5-9-5-9-5Z"/><circle cx="10" cy="7" r="2.2"/></svg>';
function jobHTML(job){const c=companyFor(job.company);return `<article class="job list-row ${viewed.has(job.id)?'viewed':''} ${job.isNew?'is-new':''}" data-job="${job.id}"><div class="job-age"><span class="new-badge" ${job.isNew?'':'hidden'}>New</span><time datetime="${new Date(job.firstObserved).toISOString()}" title="${fullTime(job)}" aria-label="${fullTime(job)}">${age(job)}</time>${eye}</div><div class="job-story"><h2 class="job-title"><a class="row-link" data-posting="${job.id}" href="${escapeHTML(postingURL(job))}" target="_blank" rel="noopener">${escapeHTML(job.title)}</a></h2><div class="job-facts"><span>${escapeHTML(job.location)}</span><span>${job.workplace}</span><span>${job.type}</span></div><span class="job-salary">${job.salary} <span aria-hidden="true">·</span> ${escapeHTML(job.skills)}</span></div><div class="job-employer"><button class="job-company" data-company="${c.id}">${mark(c)}${escapeHTML(c.name)}</button><p class="job-source">Company career page</p></div><a class="open-posting row-arrow" data-posting="${job.id}" href="${escapeHTML(postingURL(job))}" target="_blank" rel="noopener" aria-label="Open ${escapeHTML(job.title)} at ${escapeHTML(c.name)} — sample company posting in a new tab">↗</a></article>`;}
function interpret(query){const q=query.toLowerCase();let title='Your search',parts=[];
if(!q||/^(?:all fresh positions|everything|all jobs|all positions)[.!]?$/.test(q))return{title:'Everything fresh',criteria:'All roles · All locations · First seen in the last 14 days'};
const topics=[[/robot|autonom|perception|control engineer/,'Robotics'],[/backend|back.end/,'Backend'],[/design/,'Design'],[/frontend|front.end/,'Frontend'],[/data|machine learning/,'Data & ML'],[/marketing|growth/,'Marketing'],[/product manager|product roles/,'Product'],[/platform|infrastructure|software|engineer/,'Engineering']];
const topic=topics.find(([re])=>re.test(q));if(topic){title=topic[1];parts.push(topic[1]);}
if(/senior/.test(q))parts.unshift('Senior');
let place=/zurich|zürich|switzerland|swiss/.test(q)?'Switzerland':/berlin|germany|munich/.test(q)?'Germany':/london|united kingdom/.test(q)?'United Kingdom':/europe/.test(q)?'Europe':null;
if(!place){place=Object.values(countryData).find(country=>q.includes(country.name.toLowerCase()))?.name||[...new Set(Object.values(countryData).map(country=>country.region))].find(region=>q.includes(region.toLowerCase()));}
if(place){title+=` · ${place}`;parts.push(place==='Switzerland'&&/remote/.test(q)?'Zurich or remote from Switzerland':place);}
if(/remote/.test(q)&&place!=='Switzerland')parts.push('Remote');if(/\bgo\b/.test(q))parts.push('Go required');
const c=companies.find(c=>q.includes(c.name.toLowerCase()));if(c){title=c.name;parts.push(c.name);}
return{title:title==='Your search'?query.trim().slice(0,28)||'New search':title,criteria:parts.length?parts.join(' · '):'Keyword match · All locations · Last 14 days'};
}
function matches(job,query){const q=query.toLowerCase().trim();if(!q||/^(?:all fresh positions|everything|all jobs|all positions)[.!]?$/.test(q))return true;
const hay=`${job.title} ${job.category} ${job.skills} ${job.location} ${job.workplace} ${companyFor(job.company).name}`.toLowerCase();
if(/senior/.test(q)&&!['senior','staff','manager'].includes(job.level))return false;
if(/backend|back.end/.test(q)&&!/backend|platform|infrastructure/.test(job.title.toLowerCase()))return false;
if(/robot|autonom|perception|control engineer/.test(q)&&job.category!=='robotics')return false;
if(/design/.test(q)&&job.category!=='design')return false;
if(/frontend|front.end/.test(q)&&!hay.includes('frontend'))return false;
if(/machine learning/.test(q)&&!hay.includes('machine learning'))return false;
if(/data/.test(q)&&job.category!=='data')return false;
if(/marketing|growth/.test(q)&&job.category!=='marketing')return false;
if(/product manager|product roles/.test(q)&&job.category!=='product')return false;
if(/\bgo\b/.test(q)&&!job.skills.includes('Go'))return false;
if(/zurich|zürich|switzerland|swiss/.test(q)&&!job.location.includes('Switzerland'))return false;
if(/berlin|germany|munich/.test(q)&&!job.location.includes('Germany'))return false;
if(/london|united kingdom/.test(q)&&!job.location.includes('United Kingdom'))return false;
const namedRegion=[...new Set(Object.values(countryData).map(place=>place.region))].find(region=>q.includes(region.toLowerCase()));if(namedRegion&&countryData[job.country]?.region!==namedRegion)return false;
if(/remote/.test(q)&&!/zurich|zürich| or |hybrid/.test(q)&&job.workplace!=='Remote')return false;
const c=companies.find(c=>q.includes(c.name.toLowerCase()));if(c&&job.company!==c.id)return false;
const namedCountry=Object.entries(countryData).find(([,place])=>q.includes(place.name.toLowerCase()));if(namedCountry&&job.country!==namedCountry[0])return false;
const known=/backend|back.end|senior|robot|autonom|perception|control engineer|design|frontend|front.end|machine learning|data|marketing|growth|product manager|product roles|\bgo\b|zurich|zürich|switzerland|swiss|berlin|germany|munich|london|united kingdom|remote|europe|platform|engineer/;
if(!known.test(q)&&!c&&!namedCountry&&!namedRegion){const words=q.replace(/[^\w\s]/g,'').split(/\s+/).filter(w=>w.length>2&&!['roles','jobs','work','want','with','and','the','for','please','find'].includes(w));return !words.length||words.some(w=>hay.includes(w));}
return true;}
function tabs(){const root=$('#search-tabs');root.innerHTML=searches.map(s=>`<div class="search-tab"><button role="tab" id="tab-${s.id}" aria-selected="${s.id===activeSearch}" aria-controls="jobs-page" data-tab="${s.id}">${escapeHTML(s.title)}</button>${searches.length>1?`<button class="tab-remove" data-remove-tab="${s.id}" aria-label="Remove ${escapeHTML(s.title)} search">×</button>`:''}</div>`).join('');}
function current(){return searches.find(s=>s.id===activeSearch);}
const feed={generation:0,queue:[],candidates:[],cursor:0,fetching:false,complete:false,running:false,batch:0,near:false,forceGap:false,forceEnd:false};
function reduced(){return forcedReduced||matchMedia('(prefers-reduced-motion: reduce)').matches;}
function slotIsVisible(tail){const rect=tail.getBoundingClientRect();return !document.hidden&&rect.top<innerHeight-32&&rect.bottom>0;}
function status(mode){const el=$('#feed-status');el.dataset.state=mode;if(mode==='looking')el.innerHTML='<span class="looking"><span class="looking-mark" aria-hidden="true"><i></i><i></i><i></i></span>Looking for more matches…</span>';else if(mode==='end')el.innerHTML='<span class="end-mark" aria-hidden="true">—</span>No more matches in the last 14 days.<span class="end-note">From the companies we monitor. Live updates stay on.</span>';else if(mode==='empty')el.innerHTML='No matches for this search.<span class="end-note">Try changing your search, or ask us to add a company.</span>';else el.innerHTML='';}
function resetFeed(){feed.generation++;feed.queue=[];feed.cursor=0;feed.fetching=false;feed.complete=false;feed.running=false;feed.batch=0;feed.forceGap=false;feed.forceEnd=false;
feed.candidates=current().query?jobs.filter(j=>matches(j,current().query)&&j.firstObserved>=Date.now()-14*86400000).sort((a,b)=>b.firstObserved-a.firstObserved||a.id.localeCompare(b.id)):[];
const initial=feed.candidates.slice(0,12);feed.cursor=initial.length;feed.complete=feed.cursor>=feed.candidates.length;
$('#feed').innerHTML=initial.map(jobHTML).join('');$('#results-count').textContent=`${feed.candidates.length} positions`;
status(!current().query?'':!initial.length?'empty':feed.complete?'end':'');nearTail();}
function nearTail(){feed.near=location.hash.replace('#','').split('/')[0]==='jobs'||!location.hash;feed.near=feed.near&&!document.hidden&&$('#feed-tail').getBoundingClientRect().top<innerHeight-32&&$('#feed-tail').getBoundingClientRect().bottom>0;if(feed.near)pump();nearCompanyTail();}
async function refill(generation){if(feed.fetching||feed.complete||generation!==feed.generation||!feed.near)return;feed.fetching=true;feed.batch++;
const gap=feed.forceGap||feed.batch%3===0;feed.forceGap=false;
if(gap){await sleep(1450);if(generation!==feed.generation)return; // A candidate page yielded zero accepted matches; continuation is still open.
if(!feed.queue.length)status('looking');await sleep(1150);}else await sleep(850);
if(generation!==feed.generation)return;
if(feed.forceEnd){feed.cursor=feed.candidates.length;feed.forceEnd=false;}
const batch=feed.candidates.slice(feed.cursor,feed.cursor+12);feed.cursor+=batch.length;feed.queue.push(...batch);feed.complete=feed.cursor>=feed.candidates.length;feed.fetching=false;
if(feed.near)pump();}
async function animateSlot(slot){if(reduced())return;const row=$('.job, .company-row',slot);let animation;
if(motion==='dock'){const height=slot.getBoundingClientRect().height;animation=slot.animate([{height:'0px'},{height:`${height}px`,offset:.44},{height:`${height}px`}],{duration:450,easing:'cubic-bezier(.2,.65,.25,1)'});row.animate([{opacity:0,transform:'translateY(6px)'},{opacity:0,transform:'translateY(6px)',offset:.44},{opacity:1,transform:'translateY(0)',offset:.88},{opacity:1,transform:'translateY(0)'}],{duration:450});}
else if(motion==='glide')animation=row.animate([{opacity:0,transform:'translateX(-14px)'},{opacity:1,transform:'translateX(0)',offset:.85},{opacity:1,transform:'translateX(0)'}],{duration:450,easing:'cubic-bezier(.2,.65,.25,1)'});
else{animation=row.animate([{backgroundColor:'#f6aa8b'},{backgroundColor:'#f28a60'}],{duration:450,easing:'ease-out'});const stroke=document.createElement('span');stroke.className='job-stroke';row.append(stroke);const a=stroke.animate([{transform:'scaleX(0)'},{transform:'scaleX(1)'}],{duration:450,easing:'cubic-bezier(.2,.65,.25,1)'});a.finished.finally(()=>stroke.remove());}
const finish=()=>{for(const a of slot.getAnimations({subtree:true}))a.finish();};slot.addEventListener('focusin',finish,{once:true});try{await animation.finished;}catch{}finally{slot.removeEventListener('focusin',finish);}}
async function pump(){if(feed.running||!feed.near||document.hidden)return;const generation=feed.generation;feed.running=true;
try{while(generation===feed.generation&&feed.near&&!document.hidden){
if(feed.queue.length<=4&&!feed.fetching&&!feed.complete)refill(generation);
if(!feed.queue.length){if(feed.complete){status(!current().query?'':feed.candidates.length?'end':'empty');break;}status('looking');break;}
const job=feed.queue.shift();status('');const slot=document.createElement('div');slot.className='job-slot';slot.innerHTML=jobHTML(job);$('#feed').append(slot);
await Promise.all([sleep(450),animateSlot(slot)]);if(generation!==feed.generation)return;
feed.near=$('#feed-tail').getBoundingClientRect().top<innerHeight-32&&$('#feed-tail').getBoundingClientRect().bottom>0;if(feed.complete&&!feed.queue.length)status('end');
}}finally{if(generation===feed.generation){feed.running=false;if(feed.near&&feed.queue.length)queueMicrotask(pump);}}}
function loadSearch(){queryTimer++;$('.search-submit').disabled=false;$('.search-submit').innerHTML='Search <span>↵</span>';tabs();$('#query').value=current().query;$('#criteria').textContent=current().criteria;resetFeed();persist();}
$('#job-search').addEventListener('submit',async e=>{e.preventDefault();const query=$('#query').value.trim();if(!query){$('#query').focus();return;}const token=++queryTimer;const id=activeSearch;const button=$('.search-submit');button.disabled=true;button.innerHTML='Reading…';$('#criteria').textContent='Reading your search…';await sleep(650);if(token!==queryTimer||id!==activeSearch)return;Object.assign(current(),interpret(query),{query});button.disabled=false;button.innerHTML='Search <span>↵</span>';loadSearch();announce('Search updated. Newest positions are shown first.');});
$('#query').addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();$('#job-search').requestSubmit();}});
$('#add-search').addEventListener('click',()=>{activeSearch=`search-${Date.now()}`;searches.push({id:activeSearch,title:'New search',query:'',criteria:'Describe the work you’re looking for. Press Enter to search.'});loadSearch();$('#feed').innerHTML='';$('#results-count').textContent='';status('');$('#query').focus();});
$('#search-tabs').addEventListener('click',e=>{const remove=e.target.closest('[data-remove-tab]');const tab=e.target.closest('[data-tab]');if(remove){askToDeleteSearch(remove.dataset.removeTab);}else if(tab){current().draft=$('#query').value;activeSearch=tab.dataset.tab;loadSearch();$('#query').value=current().draft??current().query;}});
let pendingDeleteSearch=null;
function askToDeleteSearch(id){const search=searches.find(s=>s.id===id);if(!search||searches.length<=1)return;pendingDeleteSearch=id;$('#delete-search-description').textContent=`“${search.title}” will be removed from your searches.`;$('#delete-search-dialog').showModal();}
$('#delete-search-dialog').addEventListener('close',()=>{pendingDeleteSearch=null;});
$('#confirm-delete-search').addEventListener('click',()=>{const id=pendingDeleteSearch;const index=searches.findIndex(s=>s.id===id);if(index<0||searches.length<=1){$('#delete-search-dialog').close();return;}const wasActive=activeSearch===id;searches=searches.filter(s=>s.id!==id);$('#delete-search-dialog').close();if(wasActive){activeSearch=searches[Math.min(index,searches.length-1)].id;loadSearch();}else{tabs();persist();}const activeTab=$$('[data-tab]').find(tab=>tab.dataset.tab===activeSearch);activeTab?.focus({preventScroll:true});announce('Search deleted.');});
function updateBadges(){$('#request-count').textContent=requests.length?` (${requests.length})`:'';$('.account-plan').textContent=premium?'PLUS':'FREE';$('#premium-account').checked=premium;}
function statusHTML(c){const text={monitoring:'Monitoring',configuring:'Being added',attention:'Needs attention'}[c.status];return `<span class="status ${c.status}">${text}</span><p class="status-note">${c.status==='monitoring'?`${jobs.filter(j=>j.company===c.id).length} fresh positions`:c.status==='configuring'?'Jobs not available yet':'Updates paused'}</p>${c.status==='configuring'?`<button class="company-priority" data-priority="${c.id}" aria-label="${requests.some(r=>r.company===c.id)?'Following':'Request higher priority for'} ${escapeHTML(c.name)}" aria-pressed="${requests.some(r=>r.company===c.id)}">${requests.some(r=>r.company===c.id)?'Requested ✓':'Prioritize ↑'}</button>`:''}`;}
const companyFeed={generation:0,items:[],cursor:0,queue:[],fetching:false,complete:false,running:false,near:false,key:null};
function companyRowHTML(c,request=null){const state=request?`<span class="status ${c.status}">${{monitoring:'Monitoring',configuring:'Being added',attention:'Needs attention'}[c.status]}</span><p class="status-note">${escapeHTML(request.priority)}</p><p class="status-note">Requested ${new Date(request.created).toLocaleDateString('en-GB',{day:'numeric',month:'short'})}</p>`:statusHTML(c);return `<article class="company-row list-row${request?' request-row':''}" data-company-row="${c.id}"><div class="company-info"><a class="company-name row-link" href="#company/${c.id}">${mark(c)}${escapeHTML(c.name)}</a><span class="company-domain">${escapeHTML(c.domain)}</span></div><div class="company-industry">${escapeHTML(c.industry)}<small>${escapeHTML(c.location)}</small></div><div class="company-state">${state}</div><a class="company-open row-arrow" href="#company/${c.id}" aria-label="View ${escapeHTML(c.name)} coverage">↗</a></article>`;}
function companyScrollStatus(mode){const el=$('#company-scroll-status');el.dataset.state=mode;
if(mode==='looking')el.innerHTML='<span class="looking"><span class="looking-mark" aria-hidden="true"><i></i><i></i><i></i></span>Loading more companies…</span>';
else if(mode==='end')el.innerHTML='<span class="end-mark" aria-hidden="true">—</span>All companies in our catalogue.';
else el.innerHTML='';
}
function renderCompanies(){const q=$('#company-query').value.toLowerCase();const result=companies.filter(c=>(companyFilter==='all'||c.status===companyFilter)&&`${c.name} ${c.domain} ${c.industry}`.toLowerCase().includes(q));$('#company-count').textContent=`${result.length} ${result.length===1?'company':'companies'}`;
$('#coverage-stats').innerHTML=[['monitoring','monitoring'],['configuring','being added'],['attention','need attention']].map(([s,label])=>`<div class="stat"><b>${companies.filter(c=>c.status===s).length}</b><span>${label}</span></div>`).join('');
const key=JSON.stringify([q,companyFilter,result.map(c=>c.id)]);
if(companyFeed.key===key){for(const row of $$('#company-list [data-company-row]')){const button=$('[data-priority]',row);if(button){const following=requests.some(r=>r.company===row.dataset.companyRow);button.textContent=following?'Requested ✓':'Prioritize ↑';button.setAttribute('aria-pressed',String(following));button.setAttribute('aria-label',(following?'Following ':'Request higher priority for ')+companyFor(row.dataset.companyRow).name);}}nearCompanyTail();return;}
Object.assign(companyFeed,{generation:companyFeed.generation+1,items:result,cursor:Math.min(12,result.length),queue:[],fetching:false,complete:result.length<=12,running:false,near:false,key});
$('#company-list').innerHTML=result.length?result.slice(0,12).map(c=>companyRowHTML(c)).join(''):`<div class="empty-state"><h2>Not in our edition. Yet.</h2><p>We don’t monitor a company matching “${escapeHTML($('#company-query').value)}”.</p><a class="button dark" href="#request" data-request-query="${escapeHTML($('#company-query').value)}">Request this company +</a></div>`;
$('#company-tail').hidden=!result.length;companyScrollStatus(!result.length?'empty':companyFeed.complete?'end':'');nearCompanyTail();}
function nearCompanyTail(){companyFeed.near=location.hash==='#companies'&&companyFeed.items.length>0&&slotIsVisible($('#company-tail'));if(companyFeed.near)pumpCompanies();}
async function refillCompanies(generation){if(companyFeed.fetching||companyFeed.complete||!companyFeed.near||generation!==companyFeed.generation)return;
companyFeed.fetching=true;await sleep(850);if(generation!==companyFeed.generation)return;
const batch=companyFeed.items.slice(companyFeed.cursor,companyFeed.cursor+12);companyFeed.cursor+=batch.length;companyFeed.queue.push(...batch);companyFeed.complete=companyFeed.cursor>=companyFeed.items.length;companyFeed.fetching=false;if(companyFeed.near)pumpCompanies();}
async function pumpCompanies(){if(companyFeed.running||!companyFeed.near||document.hidden)return;const generation=companyFeed.generation;companyFeed.running=true;
try{while(generation===companyFeed.generation&&companyFeed.near&&!document.hidden){
if(companyFeed.queue.length<=4&&!companyFeed.fetching&&!companyFeed.complete)refillCompanies(generation);
if(!companyFeed.queue.length){companyScrollStatus(companyFeed.complete?'end':'looking');break;}
const company=companyFeed.queue.shift();companyScrollStatus('');const slot=document.createElement('div');slot.className='job-slot company-slot';slot.innerHTML=companyRowHTML(company);$('#company-list').append(slot);
await Promise.all([sleep(450),animateSlot(slot)]);if(generation!==companyFeed.generation)return;
companyFeed.near=location.hash==='#companies'&&slotIsVisible($('#company-tail'));if(companyFeed.complete&&!companyFeed.queue.length)companyScrollStatus('end');
}}finally{if(generation===companyFeed.generation){companyFeed.running=false;if(companyFeed.near&&companyFeed.queue.length)queueMicrotask(pumpCompanies);}}}
$('#company-query').addEventListener('input',renderCompanies);$('#company-search').addEventListener('submit',e=>{e.preventDefault();renderCompanies();});
$$('[data-status]').forEach(b=>b.addEventListener('click',()=>{companyFilter=b.dataset.status;$$('[data-status]').forEach(x=>x.setAttribute('aria-pressed',String(x===b)));renderCompanies();}));
let countryMapSource;
async function paintCompanyMap(c){const host=$('[data-map-company]');if(!host)return;
if(!countryMapSource)countryMapSource=fetch('assets/world-map.svg').then(response=>{if(!response.ok)throw new Error('Map unavailable');return response.text();}).catch(()=>{countryMapSource=null;return '';});
const source=await countryMapSource;if(!source||!host.isConnected||host.dataset.mapCompany!==c.id)return;
host.innerHTML=source;const svg=$('svg',host);
const eligibleJobs=jobs.filter(job=>job.company===c.id&&job.firstObserved>=Date.now()-14*86400000);
const countries=new Set(eligibleJobs.map(job=>job.country).filter(Boolean));
const selected=[];for(const country of countries){const path=$(`[data-country="${country}"]`,host);if(path){path.classList.add('is-hiring');selected.push(path);}}
// Fit actual country shapes, retaining a world view for empty or widely spread footprints.
let view=[0,0,1000,460];
if(selected.length){const boxes=selected.map(path=>{const values=path.dataset.focusBounds?.split(',').map(Number);return values?.length===4&&values.every(Number.isFinite)?{x:values[0],y:values[1],width:values[2],height:values[3]}:path.getBBox();});const minX=Math.min(...boxes.map(b=>b.x)),minY=Math.min(...boxes.map(b=>b.y));const maxX=Math.max(...boxes.map(b=>b.x+b.width)),maxY=Math.max(...boxes.map(b=>b.y+b.height));
const regions=new Set([...countries].map(code=>countryData[code]?.region).filter(Boolean));
if(maxX-minX<670&&regions.size<3){let width=Math.max(155,(maxX-minX)*1.55),height=Math.max(95,(maxY-minY)*1.55);const aspect=host.clientWidth/host.clientHeight;if(width/height<aspect)width=height*aspect;else height=width/aspect;if(width<=1000&&height<=460){const x=Math.max(0,Math.min(1000-width,(minX+maxX-width)/2));const y=Math.max(0,Math.min(460-height,(minY+maxY-height)/2));view=[x,y,width,height];}}}
svg.setAttribute('viewBox',view.map(value=>value.toFixed(2)).join(' '));host.dataset.mapView=selected.length?'hiring':'world';}
function careerLinksHTML(c){const pages=c.careerPages||[];return `<div class="profile-sources"><span class="last-check">${c.status==='configuring'?'Not checked yet':`Last checked ${escapeHTML(c.check)}`}</span>${pages.length?`<nav class="career-links" aria-label="Career pages">${pages.map(page=>{const address=page.url||'https://'+c.domain+(page.path||'');const display=address.replace(/^https?:\/\//,'').replace(/\/$/,'');return `<a href="sample-careers.html?${escapeHTML(new URLSearchParams({company:c.name,page:'Careers',source:address}).toString())}" target="_blank" rel="noopener" title="${escapeHTML(address)}"><span class="career-url">${escapeHTML(display)}</span><span class="career-arrow" aria-hidden="true">↗</span></a>`;}).join('')}</nav>`:''}</div>`;}
function renderCompany(id){const c=companyFor(id);if(!c){location.hash='companies';return;}const count=jobs.filter(j=>j.company===c.id).length;$('#company-page').innerHTML=`<a class="back" href="#companies">← Company catalogue</a><div class="company-hero"><div class="company-hero-copy"><div class="detail-heading">${mark(c)}<h1>${escapeHTML(c.name)}</h1></div><span class="eyebrow">${escapeHTML(c.industry)} · ${escapeHTML(c.location)}</span>${careerLinksHTML(c)}</div><div class="company-map" data-map-company="${c.id}" aria-hidden="true"></div></div><div class="company-about"><p class="detail-description">${escapeHTML(c.description)}</p><div class="detail-actions">${c.status==='monitoring'?`<button class="button dark" data-search-company="${c.id}">See ${count} positions ↗</button>`:`<button class="button dark" data-priority="${c.id}">${requests.some(r=>r.company===c.id)?'Following this company ✓':'Request higher priority ↑'}</button>`}<a class="text-link" href="#request">Request another company +</a></div></div>`;paintCompanyMap(c);}
function requestForm(value=''){requestGeneration++;$('#request-content').innerHTML=`<form class="request-form" id="discover-form"><label for="request-company">Company name or website</label><input id="request-company" type="text" required maxlength="120" autocomplete="organization" placeholder="e.g. Meridian or meridian.example" value="${escapeHTML(value)}"><p class="helper">We’ll find the company first. You confirm it before we add it.</p><button class="button dark" type="submit">Find company <span>↗</span></button><p class="small-print">Try it with any company name. This demo won’t send a real request.</p></form>`;step('find');}
function step(which){['find','confirm','add'].forEach(s=>$('#step-'+s).classList.toggle('active',s===which));}
function findCandidate(raw){const q=raw.trim().toLowerCase().replace(/^https?:\/\//,'').replace(/^www\./,'').split('/')[0];let c=companies.find(c=>c.domain.toLowerCase()===q||c.name.toLowerCase()===q||c.id===q);if(c)return c;
const dotted=q.includes('.');const stem=dotted?q.split('.')[0]:raw.trim().replace(/https?:\/\//,'').replace(/[^a-z0-9\s-]/gi,'').trim();const name=stem.split(/[\s-]+/).map(s=>s.charAt(0).toUpperCase()+s.slice(1)).join(' ')||'New Company';const id='requested-'+Date.now();return{id,name,domain:dotted?q:stem.toLowerCase().replace(/\s/g,'')+'.example',industry:'Not confirmed yet',location:'Not yet confirmed',description:`${name} is a sample company in this demo.`,mark:name[0],status:'configuring',light:false,scope:'Career pages not confirmed yet',demo:true,check:'Not started'};}
async function discover(raw){const token=++requestGeneration;$('#request-content').innerHTML='<div class="candidate"><span class="looking"><span class="looking-mark" aria-hidden="true"><i></i><i></i><i></i></span>Finding the company…</span></div>';await sleep(850);if(token!==requestGeneration)return;const c=findCandidate(raw);step('confirm');const exists=companies.some(x=>x.id===c.id);$('#request-content').innerHTML=`<div class="candidate"><span class="eyebrow">${exists?'ALREADY IN OUR CATALOGUE':'COMPANY FOUND · DEMO'}</span><div class="candidate-heading" style="margin-top:19px">${mark(c)}<h2>${escapeHTML(c.name)}</h2></div><div class="candidate-domain">${escapeHTML(c.domain)}</div><p>${escapeHTML(c.description)}</p><span class="eyebrow">${escapeHTML(c.industry)} · ${escapeHTML(c.location)}</span>${exists?`<div style="margin-top:20px">${statusHTML(c)}</div>`:''}</div><div class="candidate-actions"><button class="button dark" id="confirm-company">${c.status==='monitoring'?'See company coverage':exists?'Yes, follow this company':'Yes, that’s the one'} ↗</button><button class="text-link" id="reject-company">Not this company</button></div>${c.demo?'<p class="small-print">This is a demo company. In Justup, we’ll find the real website and company details for you to confirm.</p>':''}`;$('#confirm-company').addEventListener('click',()=>{if(c.status==='monitoring'){location.hash=`company/${c.id}`;return;}acceptCompany(c);});$('#reject-company').addEventListener('click',()=>{requestForm(raw);$('#request-company').focus();});}
function addRequest(c){const existing=requests.find(r=>r.company===c.id);if(existing)return existing;const r={id:'req-'+Date.now(),company:c.id,created:Date.now(),priority:premium?'Plus priority':'Standard request'};requests.unshift(r);persist();updateBadges();return r;}
function acceptCompany(c){if(!companies.some(x=>x.id===c.id))companies.push(c);const request=addRequest(c);persist();step('add');$('#request-content').innerHTML=`<div class="success-stamp" aria-hidden="true">ON THE LIST.</div><div class="success-copy">${escapeHTML(c.name)} is in the catalogue.</div><p class="helper">Its company profile is ready. Next, we’ll start checking its career page for jobs.</p><div class="candidate"><span class="status configuring">Being added</span><p class="status-note">${request.priority}${premium?' · Your request gets priority.':''}</p></div><div class="candidate-actions"><a class="button dark" href="#company/${c.id}">See the company ↗</a><a class="text-link" href="#requests">Track your request</a></div><p class="small-print">Jobs will appear once we start checking the company’s career page.</p>`;announce(`${c.name} added to the company catalogue.`);}
function prioritize(id){const c=companyFor(id);if(requests.some(r=>r.company===id)){toast('You’re already following this company.');return;}addRequest(c);toast(premium?`${c.name} requested with Plus priority.`:`You’re following ${c.name}.`);renderCompanies();if(location.hash.startsWith('#company/'))renderCompany(id);if(location.hash==='#requests')renderRequests();}
function renderRequests(){$('#request-list').innerHTML=requests.length?requests.map(r=>companyRowHTML(companyFor(r.company),r)).join(''):'<div class="empty-state"><h2>Your next source starts here.</h2><p>Request a company to follow its progress here.<br>Plus members get priority on setup.</p><a class="button dark" href="#request">Request a company +</a></div>';}
let pageName='';
function route(){const [page='jobs',id]=location.hash.slice(1).split('/');const valid=['jobs','companies','company','request','requests'].includes(page)?page:'jobs';const previous=pageName;pageName=valid;$$('main>.page').forEach(p=>p.hidden=p.id!==valid+'-page');$$('[data-nav]').forEach(a=>{if(a.dataset.nav===valid||(valid==='company'&&a.dataset.nav==='companies'))a.setAttribute('aria-current','page');else a.removeAttribute('aria-current');});document.title=`Justup — ${{jobs:'Live edition',companies:'Company catalogue',company:'Company coverage',request:'Request a company',requests:'Your requests'}[valid]}`;
if(valid==='companies')renderCompanies();if(valid==='company')renderCompany(id);if(valid==='requests')renderRequests();if(valid==='request'){requestForm(requestDraft);requestDraft='';}else requestGeneration++;
if(previous&&previous!==valid)window.scrollTo(0,0);nearTail();updateBackToTop();updateBadges();}
function updateBackToTop(){$('#back-to-top').hidden=window.scrollY<Math.max(480,innerHeight*.75);}
$('#back-to-top').addEventListener('click',()=>{$('.edition-name').focus({preventScroll:true});window.scrollTo({top:0,behavior:reduced()?'instant':'smooth'});});
window.addEventListener('scroll',updateBackToTop,{passive:true});window.addEventListener('resize',updateBackToTop);
window.addEventListener('hashchange',route);window.addEventListener('scroll',nearTail,{passive:true});window.addEventListener('resize',nearTail);document.addEventListener('visibilitychange',nearTail);
document.addEventListener('submit',e=>{if(e.target.id==='discover-form'){e.preventDefault();discover($('#request-company').value);}});
document.addEventListener('click',e=>{const posting=e.target.closest('[data-posting]');if(posting){const id=posting.dataset.posting;const job=jobs.find(j=>j.id===id);viewed.add(id);job.isNew=false;persist();$$('[data-job]').filter(el=>el.dataset.job===id).forEach(el=>{el.classList.add('viewed');el.classList.remove('is-new');const badge=$('.new-badge',el);if(badge)badge.hidden=true;});announce('Position marked as viewed. The sample company posting opens in a new tab.');return;}
const cp=e.target.closest('[data-company]');if(cp){location.hash='company/'+cp.dataset.company;return;}
const priority=e.target.closest('[data-priority]');if(priority){prioritize(priority.dataset.priority);return;}
const searchCompany=e.target.closest('[data-search-company]');if(searchCompany){const c=companyFor(searchCompany.dataset.searchCompany);const s={id:'company-search-'+c.id,title:c.name,query:`All positions at ${c.name}.`,criteria:`${c.name} · All roles · Last 14 days`};if(!searches.some(x=>x.id===s.id))searches.push(s);activeSearch=s.id;loadSearch();location.hash='jobs';return;}
const rq=e.target.closest('[data-request-query]');if(rq)requestDraft=rq.dataset.requestQuery;
const close=e.target.closest('[data-close]');if(close)close.closest('dialog').close();});
$$('dialog').forEach(dialog=>dialog.addEventListener('click',e=>{if(e.target===dialog){const r=dialog.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)dialog.close();}}));
$('#demo-open').addEventListener('click',()=>$('#demo-dialog').showModal());$('#account-open').addEventListener('click',()=>$('#account-dialog').showModal());
$('#premium-account').addEventListener('change',e=>{premium=e.target.checked;updateBadges();persist();});
$('#motion-select').value=motion;$('#motion-select').addEventListener('change',e=>{motion=e.target.value;persist();});
$('#reduced-motion').addEventListener('change',e=>{forcedReduced=e.target.checked;document.body.classList.toggle('reduce-motion',forcedReduced);if(forcedReduced)for(const a of document.getAnimations())if(a.effect?.getComputedTiming().iterations!==Infinity)a.finish();});
$('#simulate-live').addEventListener('click',()=>{$('#demo-dialog').close();if(pageName!=='jobs')location.hash='jobs';const template=feed.candidates[0]||jobs[0];const job={...template,id:'live-'+Date.now(),firstObserved:Date.now(),isNew:true,title:template.title};jobs.unshift(job);feed.candidates.unshift(job);feed.cursor++;$('#results-count').textContent=`${feed.candidates.length} positions`;
const anchor=$$('#feed .job').find(el=>{const r=el.getBoundingClientRect();return r.bottom>0&&r.top<innerHeight;});const before=anchor?.getBoundingClientRect().top;const slot=document.createElement('div');slot.className='job-slot';slot.innerHTML=jobHTML(job);$('#feed').prepend(slot);
// Compensate only if the reader has passed the insertion point; existing DOM and focus stay intact.
if(anchor&&window.scrollY>$('#feed').getBoundingClientRect().top+window.scrollY-100){const after=anchor.getBoundingClientRect().top;window.scrollBy(0,after-before);}else if(!reduced())animateSlot(slot);
announce('One new matching position has arrived.');toast('A fresh matching position was added at the top.');persist();});
$('#simulate-gap').addEventListener('click',()=>{$('#demo-dialog').close();location.hash='jobs';feed.generation++;feed.running=false;feed.fetching=false;feed.cursor=Math.max(0,feed.cursor-feed.queue.length);feed.queue=[];feed.complete=false;feed.forceGap=true;feed.forceEnd=false;status('looking');$('#feed-tail').scrollIntoView({block:'center',behavior:'auto'});nearTail();});
$('#simulate-end').addEventListener('click',()=>{$('#demo-dialog').close();location.hash='jobs';feed.generation++;feed.running=false;feed.fetching=false;feed.queue=feed.candidates.slice(feed.cursor,feed.cursor+3);feed.cursor=feed.candidates.length;feed.complete=true;status('');$('#feed-tail').scrollIntoView({block:'center',behavior:'auto'});nearTail();});
$('#reset-demo').addEventListener('click',()=>{try{localStorage.removeItem(STORAGE);}catch{}location.hash='jobs';location.reload();});
$('#edition-date').textContent=new Date().toLocaleDateString('en-GB',{weekday:'long',day:'numeric',month:'long',year:'numeric'}).toUpperCase();
loadSearch();route();
