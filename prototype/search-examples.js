'use strict';
// Examples are decorative text, never input values, drafts or search submissions.
// Short, detailed, editorial and playful searches are interleaved.
const searchExamplePrompts=[
 "Remote jobs.",
 "Bakery jobs in Bristol. Permanent contract, no split shifts.",
 "Night receptionist jobs. I'm a night owl, not a volunteer.",
 "Legal assistant roles in Leeds. Hybrid, training included, no unpaid trial days.",
 "Sewing and alterations jobs. A permanent contract would suit me.",
 "Museum education jobs in Glasgow. Part-time, paid preparation time.",
 "Dental nurse roles in Dublin. Visa support, paid training, no weekends.",
 "Local newspaper jobs. Proper reporting, not rewriting press releases.",
 "Community arts roles. Four days a week, accessible workplace, published salary.",
 "Chef jobs in Copenhagen. Proper breaks and overtime pay. No kitchen nightmares.",
 "Train conductor jobs with paid training. Looking for a different line of work.",
 "Veterinary receptionist roles in Cardiff. Part-time, no sales quotas.",
 "Library jobs. My indoor voice is finally a transferable skill.",
 "Nursing in Zurich. Day shifts, 80%, published pay. No rotating nights.",
 "Kitchen jobs. Less The Bear, more lunch breaks.",
 "Senior Go roles, remote from Switzerland. CHF 140k+, four days a week, no on-call. Prefer climate tech; no crypto.",
 "Remote jobs. My cat has vetoed the commute.",
 "Copy-editing jobs. I have strong feelings about the Oxford comma.",
 "Teaching jobs in Manchester. No marking until midnight.",
 "Product design, remote in Europe. €80k+, individual contributor, accessibility work. No gambling or ad tech.",
 "Bookshop jobs with paid overtime. A novel concept.",
 "Editorial jobs with time to report, not just rewrite press releases.",
 "Electrician jobs in Amsterdam. Paid travel, no weekend call-outs.",
 "Part-time jobs in Berlin.",
 "Gardening jobs. More thyme, fewer Teams calls.",
 "Robotics roles with human working hours.",
 "Fundraising for conservation charities. Hybrid, £35k+, no commission-only roles.",
 "Robotics in Germany or Austria. ROS 2 and C++, visa support, hybrid. No defence; travel under 10%.",
 "Photography jobs with a permanent contract. I can handle exposure, but I'd prefer a salary.",
 "Backend work in UTC−2 to UTC+3. Rust or Go, async team, published pay. No on-call or people management.",
 "Data journalism. Python, proper reporting, no clickbait.",
 "Stage technician jobs. Keep the drama on stage.",
 "Work that helps the planet.",
 "Warehouse jobs in Leeds. Permanent contract, fixed shifts, forklift training included.",
 "Clinical research in France, 80% time. French or English, permanent contract. No night shifts or animal testing.",
 "Office admin roles. I can organise chaos, but I'd rather not live in it.",
 "No rockstar ninja ads. Senior engineering in Europe, with actual paid leave.",
 "Local reporting, travel expenses covered. Chasing stories shouldn't mean chasing receipts.",
 "Fact-checking jobs, remote from Europe.",
 "Finance roles with real work-life balance. Not just creative accounting.",
 "Junior Python roles in London. Published pay, paid mentoring, career changers welcome. No unpaid internships.",
 "Hotel reception in Lisbon. English and Portuguese, daytime shifts, staff meals.",
 "Jobs with salary ranges.",
 "Public transport jobs with paid training. My career could use a change of platform.",
 "Fewer meetings, more building. Senior backend, remote in Europe.",
 "HR jobs, four days a week. No recruitment sales targets.",
 "Part-time Python jobs. My novel isn't going to write itself.",
 "Customer support, remote in Europe. No outbound sales or 'we're a family' culture.",
 "Remote finance roles with good parental leave. No sales targets.",
 "Museum jobs. I like old things and a decent pension.",
 "Junior Python jobs at a newspaper in London."
];
const searchExampleTiming={type:24,space:16,punctuation:90,erase:13,hold:3200,between:350};
const searchExampleState={timer:null,key:null,locale:null,index:0,position:0,phase:'typing'};
function searchExampleHoldDelay(){return searchExampleTiming.hold+Math.min(3000,Math.max(0,searchExampleCharacters().length-70)*22);}
function searchExampleKey(){return accountId+':'+(current().id||'first-search');}
function searchExampleEligible(){const route=location.hash.slice(1).split('/')[0];return(!route||route==='jobs')&&!$('#query').value.trim()&&document.activeElement!==$('#query')&&!document.hidden&&!document.querySelector('dialog[open]');}
function searchExampleCharacters(){return Array.from(I18n.text(searchExamplePrompts[searchExampleState.index]));}
function renderSearchExample(){const state=searchExampleState,el=$('#query-typing-example'),characters=searchExampleCharacters();el.textContent=characters.slice(0,state.position).join('');el.hidden=false;}
function scheduleSearchExample(delay){clearTimeout(searchExampleState.timer);searchExampleState.timer=setTimeout(tickSearchExample,delay);}
function tickSearchExample(){const state=searchExampleState;state.timer=null;if(!searchExampleEligible()||reduced()){syncSearchExample();return;}const characters=searchExampleCharacters();let delay=searchExampleTiming.type;
 if(state.phase==='typing'){state.position=Math.min(state.position+1,characters.length);if(state.position===characters.length){state.phase='holding';delay=searchExampleHoldDelay();}else if(/[.,;:]/.test(characters[state.position-1]))delay=searchExampleTiming.punctuation;else if(characters[state.position-1]===' ')delay=searchExampleTiming.space;}
 else if(state.phase==='holding'){state.phase='erasing';delay=searchExampleTiming.erase;}
 else if(state.phase==='erasing'){state.position=Math.max(0,state.position-1);delay=searchExampleTiming.erase;if(!state.position){state.phase='next';delay=searchExampleTiming.between;}}
 else{state.index=(state.index+1)%searchExamplePrompts.length;state.position=0;state.phase='typing';delay=100;}
 renderSearchExample();scheduleSearchExample(delay);
}
function syncSearchExample(){const state=searchExampleState,el=$('#query-typing-example');if(!el)return;clearTimeout(state.timer);state.timer=null;const key=searchExampleKey();if(state.key!==key||state.locale!==I18n.locale){state.key=key;state.locale=I18n.locale;state.index=0;state.position=0;state.phase='typing';}
 if(!searchExampleEligible()){el.hidden=true;return;}
 $('#query').placeholder='';const isStatic=reduced();el.classList.toggle('is-static',isStatic);if(isStatic){state.position=searchExampleCharacters().length;state.phase='holding';renderSearchExample();return;}
 renderSearchExample();scheduleSearchExample(state.phase==='holding'?searchExampleHoldDelay():state.position?searchExampleTiming.type:searchExampleTiming.between);
}
function stopSearchExample(){const state=searchExampleState;clearTimeout(state.timer);state.timer=null;$('#query-typing-example').hidden=true;$('#query').placeholder='';}
function initSearchExamples(){const input=$('#query');for(const event of ['pointerdown','focus','beforeinput','input','paste','compositionstart'])input.addEventListener(event,stopSearchExample);input.addEventListener('blur',syncSearchExample);document.addEventListener('visibilitychange',syncSearchExample);matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change',syncSearchExample);document.addEventListener('change',event=>{if(['language-choice','settings-reduced','reduced-motion'].includes(event.target.id))queueMicrotask(syncSearchExample);});window.addEventListener('languagechange',()=>queueMicrotask(syncSearchExample));for(const dialog of $$('dialog')){dialog.addEventListener('close',syncSearchExample);dialog.addEventListener('toggle',syncSearchExample);}}
