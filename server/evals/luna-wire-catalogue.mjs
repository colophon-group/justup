// Credential-free request diagnostics only. Read all pinned Responses/Lite tool
// carriers in memory; return counts/hashes, never messages, IDs or raw schemas.
import { createHash } from 'node:crypto';

const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&Object.getPrototypeOf(value)===Object.prototype;
const invalid=()=>Object.assign(new Error('The complete wire catalogue could not be verified.'),{code:'unverified_catalogue'});
const canonical=value=>JSON.stringify(Array.isArray(value)?value.map(item=>JSON.parse(canonical(item))):object(value)?Object.fromEntries(Object.keys(value).sort().map(key=>[key,JSON.parse(canonical(value[key]))])):value);
const hash=value=>createHash('sha256').update(canonical(value)).digest('hex');
const topKeys=new Set(['model','instructions','input','tools','tool_choice','parallel_tool_calls','reasoning','store','stream','stream_options','include','service_tier','prompt_cache_key','text','client_metadata','access_programs','previous_response_id']);
const metadataKeys=new Set(['x-codex-installation-id','session_id','thread_id','x-codex-window-id','turn_id','x-openai-subagent','x-codex-parent-thread-id','parent_turn_id','root_turn_id','x-codex-turn-metadata','mcp_attribution']);
const turnKeys=new Set(['installation_id','session_id','thread_id','agent_name','turn_id','window_id','window_number','context_window_id','request_kind','compaction','turn_started_at_unix_ms','history_ingest_requested','analytics_enabled','forked_from_thread_id','forked_from_ordinal_exclusive','parent_thread_id','parent_turn_id','root_turn_id','subagent_kind','thread_source','turn_trigger','sandbox','sandbox_mode','auto_review_enabled','node_repl_auto_review_required','node_repl_disabled','workspaces','tool_namespaces_info','model','reasoning_effort','codex_version','user_input_requested_during_turn','workspace_kind']);
function known(value,keys){if(!object(value)||Object.keys(value).some(key=>!keys.has(key)))throw invalid();}

export function inspectWireCatalogue(body,{transport='responses_lite',model='gpt-6-luna'}={}) {
  if(!['responses','responses_lite'].includes(transport))throw invalid();
  known(body,topKeys);
  if(body.model!==model||!Array.isArray(body.input)||body.input.length>128||Buffer.byteLength(JSON.stringify(body))>4_194_304)throw invalid();
  if(body.access_programs!=null)throw invalid();
  const roots=[],schemaHashes=[];
  let toolCount=0,namespaceCount=0,additionalToolsItems=0,additionalToolsCount=0,topLevelToolsCount=0,metadataToolCount=0;
  function specs(values,depth=0){
    if(!Array.isArray(values)||values.length>512||depth>8)throw invalid();
    for(const spec of values){
      if(!object(spec)||typeof spec.type!=='string'||++toolCount>1024)throw invalid();
      schemaHashes.push(hash(spec));
      if(spec.type==='namespace'){
        known(spec,new Set(['type','name','description','tools']));
        if(typeof spec.name!=='string'||!spec.name||spec.name.length>256)throw invalid();
        namespaceCount++;specs(spec.tools,depth+1);
      }else if(!['function','custom','web_search','web_search_preview','image_generation','code_interpreter','file_search','computer_use_preview','computer'].includes(spec.type))throw invalid();
    }
  }
  if(Object.hasOwn(body,'tools')){
    if(!Array.isArray(body.tools))throw invalid();
    topLevelToolsCount=body.tools.length;roots.push(...body.tools);specs(body.tools);
  }
  for(const [index,item] of body.input.entries()){
    if(!object(item))throw invalid();
    if(item.type==='additional_tools'){
      known(item,new Set(['id','type','role','tools']));
      if(item.role!=='developer'||!Array.isArray(item.tools)||index!==0||++additionalToolsItems>1)throw invalid();
      additionalToolsCount+=item.tools.length;roots.push(...item.tools);specs(item.tools);
    }else if(item.type==='message'){
      known(item,new Set(['id','type','role','content','phase','channel','recipient','internal_chat_message_metadata_passthrough']));
      if(!['user','developer','system'].includes(item.role)||!Array.isArray(item.content))throw invalid();
      if(item.internal_chat_message_metadata_passthrough!==undefined){
        known(item.internal_chat_message_metadata_passthrough,new Set(['content_item_kinds']));
        if(!Array.isArray(item.internal_chat_message_metadata_passthrough.content_item_kinds)||item.internal_chat_message_metadata_passthrough.content_item_kinds.some(value=>typeof value!=='string'))throw invalid();
      }
      for(const content of item.content){
        known(content,new Set(['type','text']));
        if(content.type!=='input_text'||typeof content.text!=='string')throw invalid();
      }
    }else throw invalid(); // Unknown input carriers never qualify as zero tools.
  }
  if(transport==='responses_lite'&&additionalToolsItems!==1||transport==='responses'&&(additionalToolsItems!==0||!Object.hasOwn(body,'tools')))throw invalid();
  if(body.client_metadata!==undefined){
    known(body.client_metadata,metadataKeys);
    if(Object.values(body.client_metadata).some(value=>typeof value!=='string'))throw invalid();
    const encoded=body.client_metadata['x-codex-turn-metadata'];
    if(encoded!==undefined){
      let metadata;try{metadata=JSON.parse(encoded);}catch{throw invalid();}
      known(metadata,turnKeys);
      const inventory=metadata.tool_namespaces_info;
      if(inventory!==undefined){
        if(!object(inventory))throw invalid();
        for(const namespace of Object.values(inventory)){
          known(namespace,new Set(['name','functions']));
          if(typeof namespace.name!=='string'||!namespace.name||!object(namespace.functions))throw invalid();
          metadataToolCount+=Object.keys(namespace.functions).length;
        }
      }
    }
  }
  return {transport,topLevelToolsCount,additionalToolsItems,additionalToolsCount,namespaceCount,toolCount,metadataToolCount,toolCatalogSha256:hash(roots),schemaHashes};
}

export function assertEmptyWireCatalogue(body,options){
  const result=inspectWireCatalogue(body,options);
  if(result.toolCount!==0||result.metadataToolCount!==0)throw Object.assign(invalid(),{counts:result});
  return result;
}
