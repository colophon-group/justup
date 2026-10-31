'use strict';
// Examples are decorative text, never input values, drafts or search submissions.
// Short, detailed, editorial and playful searches are interleaved.
const searchExamplePrompts=[
 "Remote jobs.",
 "Junior Python jobs at a newspaper in London.",
 "Senior Go roles, remote from Switzerland. CHF 140k+, four days a week, no on-call. Prefer climate tech; no crypto.",
 "Remote jobs. My cat has vetoed the commute.",
 "Product design in Europe.",
 "Product design, remote in Europe. €80k+, individual contributor, accessibility work. No gambling or ad tech.",
 "Editorial jobs with time to report, not just rewrite press releases.",
 "Part-time jobs in Berlin.",
 "Robotics roles with human working hours.",
 "Robotics in Germany or Austria. ROS 2 and C++, visa support, hybrid. No defence; travel under 10%.",
 "Go jobs. Please, no more crypto.",
 "Junior data analyst roles.",
 "Backend work in UTC−2 to UTC+3. Rust or Go, async team, published pay. No on-call or people management.",
 "Data journalism. Python, proper reporting, no clickbait.",
 "Work that helps the planet.",
 "Clinical research in France, 80% time. French or English, permanent contract. No night shifts or animal testing.",
 "No rockstar ninja ads. Senior engineering in Europe, with actual paid leave.",
 "Fact-checking jobs, remote from Europe.",
 "Junior Python roles in London. Published pay, paid mentoring, career changers welcome. No unpaid internships.",
 "Jobs with salary ranges.",
 "Fewer meetings, more building. Senior backend, remote in Europe.",
 "Engineering manager in Berlin. Small team, hands-on coding, four-day week. No ad tech or weekend on-call.",
 "Part-time Python jobs. My novel isn't going to write itself.",
 "Remote finance roles with good parental leave. No sales targets."
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
