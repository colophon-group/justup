'use strict';
// Examples are decorative text, never input values, drafts or search submissions.
const searchExamplePrompts=[
 'Senior backend roles in Switzerland. Go required.',
 'Product design roles in Europe.',
 'Robotics roles in Germany.',
 'Remote engineering roles in Europe. Go preferred.',
 'Senior data roles with a published salary.'
];
const searchExampleState={timer:null,key:null,locale:null,index:0,position:0,phase:'typing',stopped:new Set()};
function searchExampleKey(){return accountId+':'+(current().id||'first-search');}
function searchExampleEligible(){const route=location.hash.slice(1).split('/')[0];return(!route||route==='jobs')&&!current().query&&!$('#query').value&&document.activeElement!==$('#query')&&!document.hidden&&!document.querySelector('dialog[open]')&&!searchExampleState.stopped.has(searchExampleKey());}
function searchExampleCharacters(){return Array.from(I18n.text(searchExamplePrompts[searchExampleState.index]));}
function renderSearchExample(){const state=searchExampleState,el=$('#query-typing-example'),characters=searchExampleCharacters();el.textContent=characters.slice(0,state.position).join('');el.hidden=false;}
function scheduleSearchExample(delay){clearTimeout(searchExampleState.timer);searchExampleState.timer=setTimeout(tickSearchExample,delay);}
function tickSearchExample(){const state=searchExampleState;state.timer=null;if(!searchExampleEligible()||reduced()){syncSearchExample();return;}const characters=searchExampleCharacters();let delay=55;
 if(state.phase==='typing'){state.position=Math.min(state.position+1,characters.length);if(state.position===characters.length){state.phase='holding';delay=2300;}else if(/[.,]/.test(characters[state.position-1]))delay=180;}
 else if(state.phase==='holding'){state.phase='erasing';delay=30;}
 else if(state.phase==='erasing'){state.position=Math.max(0,state.position-1);delay=27;if(!state.position){state.phase='next';delay=450;}}
 else{state.index=(state.index+1)%searchExamplePrompts.length;state.position=0;state.phase='typing';delay=100;}
 renderSearchExample();scheduleSearchExample(delay);
}
function syncSearchExample(){const state=searchExampleState,el=$('#query-typing-example');if(!el)return;clearTimeout(state.timer);state.timer=null;const key=searchExampleKey();if(state.key!==key||state.locale!==I18n.locale){state.key=key;state.locale=I18n.locale;state.index=0;state.position=0;state.phase='typing';}
 if(!searchExampleEligible()){el.hidden=true;return;}
 $('#query').placeholder='';const isStatic=reduced();el.classList.toggle('is-static',isStatic);if(isStatic){state.position=searchExampleCharacters().length;state.phase='holding';renderSearchExample();return;}
 renderSearchExample();scheduleSearchExample(state.phase==='holding'?2300:state.position?55:450);
}
function stopSearchExample(){const state=searchExampleState;state.stopped.add(searchExampleKey());clearTimeout(state.timer);state.timer=null;$('#query-typing-example').hidden=true;$('#query').placeholder='';}
function initSearchExamples(){const input=$('#query');for(const event of ['pointerdown','focus','beforeinput','input','paste','compositionstart'])input.addEventListener(event,stopSearchExample);input.addEventListener('blur',syncSearchExample);document.addEventListener('visibilitychange',syncSearchExample);matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change',syncSearchExample);document.addEventListener('change',event=>{if(['language-choice','settings-reduced','reduced-motion'].includes(event.target.id))queueMicrotask(syncSearchExample);});window.addEventListener('languagechange',()=>queueMicrotask(syncSearchExample));for(const dialog of $$('dialog')){dialog.addEventListener('close',syncSearchExample);dialog.addEventListener('toggle',syncSearchExample);}}
