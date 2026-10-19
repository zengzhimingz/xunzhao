'use strict';
const $=id=>document.getElementById(id);
const icon=name=>`<svg class="icon" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const labels={need:'客户诉求',history:'客户自述的既往情况',progress:'本次沟通进展',pricing:'项目与费用说明',appointment:'到店与预约',notes:'后续事项 / 补充备注'};
const hints={need:'材料中没有明确诉求时留空',history:'未提供不等于“没有做过”，可留空',progress:'本次介绍了什么，客户关心什么，是否已经选定',pricing:'区分展示金额、活动报价与收费条件',appointment:'没有明确时间时可留空，不影响保存',notes:'可选：补充本次已核实的信息'};
let recordFilter='all';
let inlineIndex=0,inlineRefs=[],inlineLabel='',previewMode='image',inlineRenderKey='',sourceAutoApplied=false;
let creatingRecord=false;
let token='',connected=false,installed=false,rows=[],active=null,uploadTarget=null,uploading=false,saving=false;
let dirtyFields={},editTimer=null,patchChain=Promise.resolve(),pollTimer=null,toastTimer=null,sourceIndex=0,sourceRefs=[],listPoll=null;
let acknowledged={identity:false,partial:false},renderedId=null,saveOperation=null,filesRenderKey='',ackScope='',notesHadText=false;
const isProcessing=r=>r&&['queued','processing','uploading'].includes(r.status);
const title=r=>r.fields.name.text.trim()||'客户 · '+r.id.slice(0,6).toUpperCase();
const date=value=>new Date(value*1000).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false});
const fileName=file=>file.name||'粘贴图片.png';
function toast(message){$('toast').textContent=message;$('toast').classList.add('visible');clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').classList.remove('visible'),4500)}
function readableError(message){if(/模型.*(?:原文|事实|格式|记录|数字|报价)/.test(message))return '本次提取内容未能通过原文核对，已停止自动填写。原始资料已保留，可重新整理或直接填写。';return message}
function notice(message){$('notice').textContent=message;$('notice').hidden=!message}
function fit(element){element.style.height='auto';element.style.height=Math.max(64,element.scrollHeight+2)+'px'}
function backup(){if(!active)return;try{localStorage.setItem('care-record-edit-v5:'+active.id,JSON.stringify(dirtyFields))}catch{notice('浏览器临时备份不可用，请等待“草稿已暂存”后离开。')}}
async function api(path,data,blob=false,name=''){
 const headers={'X-Local-Token':token,'X-Demo-Role':currentRole,'X-Demo-Doctor':currentDoctor,'Content-Type':blob?'application/octet-stream':'application/json'};if(name)headers['X-File-Name']=encodeURIComponent(name);
 let response;try{response=await fetch(path,{method:data===undefined?'GET':'POST',headers,body:data===undefined?undefined:blob?data:JSON.stringify(data),signal:AbortSignal.timeout(blob?120000:30000)})}catch{throw new Error('本机服务连接中断，请重新启动。已经上传的资料和已暂存的草稿仍在。')}
 const value=await response.json();if(!response.ok)throw new Error(value.error||'本次操作未完成，请重试');return value;
}
function takeRecord(record){
 if(active?.id!==record.id){dirtyFields={};acknowledged={identity:record.identityAcknowledged,partial:record.partialAcknowledged};saveOperation=null}
 active=record;
 const scope=JSON.stringify([record.id,record.identityWarning,record.files.map(f=>[f.id,f.excluded,f.status==='error'])]);
 if(scope!==ackScope){ackScope=scope;acknowledged={identity:record.identityAcknowledged,partial:record.partialAcknowledged}}
 for(const [key,value] of Object.entries(dirtyFields))active.fields[key]={...active.fields[key],text:value,modified:true,status:value.trim()?'manual':'empty',refs:[]};
 renderEditor();
}
async function loadRows(){if(currentRole!=='consultant')return;try{rows=(await api('/api/records')).records;renderList();clearTimeout(listPoll);if(!$('homeView').hidden&&rows.some(isProcessing))listPoll=setTimeout(loadRows,1500)}catch(error){notice(error.message)}}
function renderList(){
 const query=$('search').value.trim().toLowerCase();
 const isSaved=row=>row.status==='saved'&&!row.dirty;
 const counts={all:rows.length,saved:rows.filter(isSaved).length,draft:rows.filter(row=>!isSaved(row)).length};
 const filtered=rows.filter(row=>(recordFilter==='all'||(recordFilter==='saved'?isSaved(row):!isSaved(row)))&&[title(row),...Object.values(row.fields).map(f=>f.text)].join(' ').toLowerCase().includes(query));
 $('savedCount').textContent=counts.all;$('sideDraftCount').textContent=counts.draft;$('sideSavedCount').textContent=counts.saved;$('recordCount').textContent=rows.length;
 $('homeBtn').classList.toggle('active',recordFilter==='all');for(const button of document.querySelectorAll('[data-nav-filter]'))button.classList.toggle('active',button.dataset.navFilter===recordFilter);
 for(const key of ['all','draft','saved'])$('count-'+key).textContent=counts[key];
 for(const button of document.querySelectorAll('[data-filter]')){const selected=button.dataset.filter===recordFilter;button.classList.toggle('active',selected);button.setAttribute('aria-pressed',String(selected))}
 $('listSummary').textContent=query?'找到 '+filtered.length+' 条相关记录':'共 '+rows.length+' 条记录 · 当前显示 '+filtered.length+' 条';
 if(!filtered.length){$('recordList').innerHTML='<div class="empty-list"><span>'+icon(query?'search':'file')+'</span><strong>'+(query?'没有找到相关记录':recordFilter==='all'?'还没有客户档案':recordFilter==='saved'?'还没有已保存的档案':'当前没有待完成的记录')+'</strong><p>'+(query?'试试客户代号、电话或诉求中的其他关键词。':recordFilter==='all'?'上传同一客户的资料，系统会自动保留原图和草稿。':'可切换到全部记录查看。')+'</p></div>';return}
 $('recordList').innerHTML='<table class="record-table"><thead><tr><th>客户</th><th>本次诉求</th><th>资料</th><th>状态</th><th>最近更新</th><th><span class="sr-only">打开档案</span></th></tr></thead><tbody>'+filtered.map(row=>{
  const working=isProcessing(row),saved=isSaved(row);
  const state=working?'整理中':row.savedRevision&&row.dirty?'待保存更改':saved?'已保存':row.status==='error'?'待处理':row.mode==='ai'&&row.aiApplied.length?'待核对':'草稿';
  const label=title(row),initial=row.fields.name.text.trim().slice(0,1)||'客';
  const manualOnly=row.mode==='manual'||(row.savedRevision&&!row.aiApplied.length&&Object.values(row.fields).some(f=>f.modified&&f.text.trim()));
  const method=manualOnly?'人工录入':'AI 辅助填写';
  return `<tr><td><div class="client-cell"><span class="client-avatar ${row.mode==='manual'?'manual':''}" aria-hidden="true">${esc(initial)}</span><div><button class="record-link" data-open="${row.id}" title="${esc(label)}">${esc(label)}</button><small>${method} · ${channelLabels[row.channel]||'未标注'}</small></div></div></td><td><div class="record-need ${row.fields.need.text?'':'empty'}" title="${esc(row.fields.need.text)}">${esc(row.fields.need.text||'尚未填写诉求')}</div></td><td><span class="file-total">${icon('file')}${row.files.filter(f=>!f.excluded).length}</span></td><td><span class="badge ${working?'working':saved?'saved':row.dirty&&row.savedRevision?'pending':''}"><span class="dot"></span>${state}</span></td><td><span class="record-date">${date(row.updatedAt)}</span></td><td><button class="row-open" data-open="${row.id}" aria-label="打开${esc(label)}">${icon('arrow')}</button></td></tr>`;
 }).join('')+'</tbody></table>';
}
function buildFields(){
 const heading=(number,text,help='')=>`<div class="form-section-heading"><span class="section-marker">${number}</span><h3>${text}</h3>${help?'<small>'+help+'</small>':''}</div>`;
 const field=key=>`<label class="field"><span>${labels[key]}${key==='notes'?'<small>可留空</small>':''}</span><textarea id="field-${key}" aria-label="${labels[key]}" data-field="${key}" maxlength="2500" rows="2" placeholder="${hints[key]}"></textarea><div class="field-footer"><button type="button" class="text-button" data-evidence="${key}" hidden></button><span id="mark-${key}"></span></div></label>`;
 $('contentFields').innerHTML=heading('02','需求与背景')+'<div class="paired-fields">'+field('need')+field('history')+'</div>'+heading('03','沟通与安排','核对费用、进展与预约')+field('progress')+field('pricing')+field('appointment')+'<details id="notesDetails" class="notes-details"><summary>后续事项 / 补充备注 <small>可选</small></summary>'+field('notes')+'</details>';
 $('notesDetails').ontoggle=()=>fit($('field-notes'));
}
function renderEditor(){
 if(!active)return;
 const manualOnly=active.mode==='manual'||(active.status==='saved'&&!active.aiApplied.length&&Object.values(active.fields).some(f=>f.modified&&f.text.trim()));
 const busy=isProcessing(active)||uploading;const same=renderedId===active.id;renderedId=active.id;
 if(!same){previewMode='image';notesHadText=false;$('notesDetails').open=false;inlineIndex=0;inlineRefs=[];inlineLabel='';inlineRenderKey='';sourceAutoApplied=false}
 document.body.dataset.view='editor';$('homeView').hidden=true;$('editorView').hidden=false;$('pageLabel').textContent='客户记录';
 $('recordChannel').value=active.channel||'unspecified';$('recordChannel').disabled=busy||saving;
 renderHandoffStatus();
 $('recordTitle').textContent=title(active);$('recordSubtitle').textContent='档案编号 '+active.id.slice(0,8).toUpperCase()+' · '+(manualOnly?'人工录入':'AI 辅助填写');
 document.querySelector('.record-state').dataset.state=active.status==='error'?'error':active.status==='saved'&&!active.dirty?'saved':'draft';
 $('stepFillLabel').textContent=manualOnly?'人工填写':'AI 整理';
 const completed=active.status==='saved'&&!active.dirty&&!busy;
 const step=completed?3:uploading?0:busy||active.status==='error'?1:active.mode==='manual'?1:active.aiApplied.length?2:0;
 for(const [index,item] of [...$('editorSteps').children].entries()){item.classList.toggle('done',completed||index<step);item.classList.toggle('active',!completed&&index===step);item.querySelector('b').innerHTML=completed||index<step?icon('check'):String(index+1);if(!completed&&index===step)item.setAttribute('aria-current','step');else item.removeAttribute('aria-current')}
 $('recordState').textContent=busy?'正在整理':active.status==='error'?'整理未完成':active.savedRevision&&active.dirty?'待保存更改':active.status==='saved'?'已保存':'草稿';
 $('draftState').textContent=Object.keys(dirtyFields).length?'正在暂存修改…':active.status==='saved'&&!active.dirty?'已写入本机档案库':'原始资料与草稿已在本机保留';
 const files=active.files.filter(f=>!f.excluded);$('fileCount').textContent=files.length;
 const fileKey=active.id+JSON.stringify(active.files.map(f=>[f.id,f.status,f.excluded]))+busy+active.mode;
 if(fileKey!==filesRenderKey){filesRenderKey=fileKey;$('fileList').innerHTML=active.files.map((f,i)=>`<div class="file-card ${f.excluded?'excluded':''}"><button class="file-open" data-file="${i}" aria-label="查看资料${i+1}：${esc(f.name)}" title="${esc(f.name)}">${f.mime.startsWith('image/')?`<img class="file-thumb" src="${f.url}" alt="">`:f.mime.startsWith('audio/')?'<span class="file-thumb file-audio-thumb">'+icon('mic')+'</span>':'<span class="file-thumb text-thumb">TXT</span>'}<span class="file-meta"><span class="file-name">资料 ${i+1}</span><span class="file-status ${f.status==='error'?'error':''}">${f.excluded?'已移出':f.status==='done'?(f.mime.startsWith('audio/')?'已转写':'已识别'):f.status==='error'?(f.mime.startsWith('audio/')?'转写失败':'识别失败'):active.mode==='manual'?'原始资料':'等待识别'}</span></span></button></div>`).join('')}
 if(!sourceAutoApplied&&!busy&&active.fields.need.refs.length){const refs=active.fields.need.refs;inlineIndex=active.sources[refs[0]]?.docIndex||0;inlineRefs=refs;inlineLabel='客户诉求';sourceAutoApplied=true}
 const evidenceKey=Object.keys(labels).find(key=>labels[key]===inlineLabel);if(evidenceKey){inlineRefs=active.fields[evidenceKey].refs;if(inlineRefs.length&&!busy&&!inlineRefs.some(ref=>active.sources[ref]?.docIndex===inlineIndex))inlineIndex=active.sources[inlineRefs[0]]?.docIndex||0}
 renderInlinePreview();
 $('addFiles').disabled=busy||saving;$('editorDrop').disabled=busy||saving;$('processStatus').hidden=!busy;
 $('processTitle').textContent=uploading?'正在接收资料':active.mode==='manual'?'正在准备原始材料':'正在自动填写记录';$('processDetail').textContent=uploading?'上传完成后自动开始，无需另点生成。':active.stage;
 $('retryBtn').hidden=busy||active.mode==='manual'||!files.length;$('retryBtn').disabled=!installed||saving;
 $('resultInfo').hidden=true;
 $('resultInfo').textContent='原始资料已保留。自动填写的内容，可在右侧直接核对和修改。';
 $('fillSummary').textContent=busy?(active.mode==='manual'?'准备原图中…':'自动填写中…'):active.aiApplied.length?'✦ AI 已填 '+active.aiApplied.length+' 项':active.mode==='manual'?'人工填写':'可直接编辑';
 for(const [key,field] of Object.entries(active.fields)){
  const input=$('field-'+key);if(!same||(!Object.hasOwn(dirtyFields,key)&&document.activeElement!==input))input.value=field.text;
  if(key==='notes'){if(field.text&&!notesHadText)$('notesDetails').open=true;notesHadText=!!field.text}
  if(input.tagName==='TEXTAREA')fit(input);
  if(key in labels){const button=document.querySelector(`[data-evidence="${key}"]`);button.hidden=!field.refs.length;button.innerHTML=icon('quote')+'查看依据';input.closest('.field').classList.toggle('needs-review',field.status==='uncertain');$('mark-'+key).textContent=field.modified?'已人工修改':field.status==='missing'?'未提供 · 可留空':field.status==='uncertain'?'需核实':field.refs.length?'AI 填写':'';$('mark-'+key).classList.toggle('manual-mark',field.modified);$('mark-'+key).dataset.status=field.status}
 }
 $('recordFields').disabled=saving;
 const errors=files.filter(f=>f.status==='error');
 const fieldValues=Object.values(active.fields),filled=fieldValues.filter(f=>f.refs.length&&!f.modified).length,manual=fieldValues.filter(f=>f.modified&&f.text.trim()).length,uncertain=fieldValues.filter(f=>f.status==='uncertain').length;
 $('fillSummary').textContent=busy?'整理中…':active.status==='error'?'待处理':manualOnly?'人工录入':'AI 辅助填写';
 $('reviewSummary').classList.toggle('has-error',active.status==='error');
 $('reviewSummary').innerHTML=icon(busy?'clock':active.status==='error'?'help':'spark')+'<strong>'+(busy?'正在从原始资料中整理':active.status==='error'?'自动整理未完成':active.mode==='manual'?'人工填写档案':filled?'已从资料填入 '+filled+' 项':'可直接编辑档案')+'</strong>'+(manual?'<span class="summary-divider"></span><span>已修改 '+manual+' 项</span>':'')+(uncertain?'<span class="summary-divider"></span><span class="review-alert">'+uncertain+' 项需核实</span>':'')+'<span class="summary-divider"></span><small>'+(active.status==='error'?'原始资料已保留，可重试或直接填写':active.status==='saved'&&!active.dirty?'记录已留存':'核对事实后保存')+'</small>';
 $('checks').classList.toggle('info-only',!active.error&&!active.identityWarning&&!errors.length);
 const missing=Object.entries(active.fields).filter(([key,f])=>key in labels&&key!=='notes'&&f.status==='missing').map(([key])=>labels[key]);
 $('checks').hidden=busy||(!active.error&&!active.identityWarning&&!errors.length&&!missing.length);
 $('checks').innerHTML=(active.error?'<p>'+esc(readableError(active.error))+'</p>':'')+(missing.length?'<p>材料未提供：'+missing.join('、')+'。可留空保存，后续拿到信息再补。</p>':'')+(active.identityWarning?'<p>'+esc(active.identityWarning)+'</p><label><input type="checkbox" id="identityAck" '+(acknowledged.identity?'checked':'')+'>我已核对，这些材料属于同一客户。</label>':'')+(errors.length?'<p>'+errors.length+' 份资料未识别成功。可重新整理，也可暂不纳入。</p><label><input type="checkbox" id="partialAck" '+(acknowledged.partial?'checked':'')+'>我已知晓未识别资料暂不纳入本次记录。</label>':'');
 const hasContent=['need','history','progress','pricing','notes'].some(key=>$('field-'+key).value.trim());
 const blocked=(active.identityWarning&&!acknowledged.identity)||(errors.length&&!acknowledged.partial);
 $('saveBtn').disabled=busy||saving||!hasContent||blocked||(!active.dirty&&active.status==='saved'&&!Object.keys(dirtyFields).length);
 $('saveBtn').innerHTML=saving?'正在保存…':active.savedRevision?'保存更改 '+icon('check'):'确认并保存档案 '+icon('check');
 $('saveHint').textContent=busy?(active.mode==='manual'?'原图准备后即可填写':'AI 填表后，核对即可保存'):active.status==='saved'&&!active.dirty?'已保存到本机档案库':blocked?'请先核对上方资料问题':'核对后直接保存，缺失项可留空';
 $('savedReceipt').hidden=active.status!=='saved'||active.dirty||busy;
 if(!$('savedReceipt').hidden)$('savedReceipt').innerHTML='✓ 已保存到客户档案 · '+date(active.savedAt)+'<small>原始资料与记录已留存，可返回列表或刷新后重新打开。</small>';
}
function schedulePoll(){clearTimeout(pollTimer);if(!active||!isProcessing(active)||uploading)return;pollTimer=setTimeout(async()=>{const id=active?.id;if(!id)return;try{const {record}=await api('/api/records/'+id);if(active?.id===id){takeRecord(record);if(!isProcessing(record)){await loadRows();if(record.status==='ready')toast(record.files.some(f=>f.status==='error'&&!f.excluded)?'部分资料未识别，请核对页面提示后保存。':record.mode==='ai'?'资料已自动填入，核对后可直接保存。':'原图已保留，可开始人工填写。')}schedulePoll()}}catch(error){notice(error.message)}},900)}
async function openRecord(id){
 if(currentRole!=='consultant')return;
 await flushEdits();notice('');let {record}=await api('/api/records/'+id);if(record.status==='uploading'&&record.files.length&&!uploading)record=(await api('/api/records/'+id+'/process',{})).record;takeRecord(record);
 try{const saved=JSON.parse(localStorage.getItem('care-record-edit-v5:'+id)||'{}');if(Object.keys(saved).length){dirtyFields=saved;takeRecord(record);await flushEdits()}}catch{}
 location.hash='record='+id;window.scrollTo({top:0,behavior:'instant'});schedulePoll();
}
async function home(){if(currentRole!=='consultant')return showRoleHome();if(uploading||saving||creatingRecord){toast('资料接收或保存即将完成，请稍候。');return}await flushEdits();clearTimeout(pollTimer);stopMedia();active=null;renderedId=null;document.body.dataset.view='home';$('homeView').hidden=false;$('editorView').hidden=true;$('pageLabel').textContent='客户档案';location.hash='';window.scrollTo({top:0,behavior:'instant'});notice('');await loadRows()}
function flushEdits(){
 clearTimeout(editTimer);if(!active||!Object.keys(dirtyFields).length)return patchChain;
 const id=active.id,values={...dirtyFields};
 patchChain=patchChain.catch(()=>{}).then(async()=>{
  const {record}=await api('/api/records/'+id+'/fields',{fields:values});
  if(active?.id===id){for(const [key,value] of Object.entries(values))if(dirtyFields[key]===value)delete dirtyFields[key];backup();takeRecord(record)}
 }).catch(error=>{notice(error.message);throw error});
 return patchChain;
}
function onEdit(event){
 const key=event.target.dataset.field;if(!key||!active)return;
 dirtyFields[key]=event.target.value;active.dirty=true;active.fields[key]={...active.fields[key],text:event.target.value,modified:true,status:event.target.value.trim()?'manual':'empty',refs:[]};
 if(inlineLabel===labels[key]){inlineRefs=[];inlineLabel='';inlineRenderKey=''}
 saveOperation=null;backup();clearTimeout(editTimer);editTimer=setTimeout(()=>flushEdits().catch(()=>{}),450);
 if(event.target.tagName==='TEXTAREA')fit(event.target);$('savedReceipt').hidden=true;renderEditor();
}
async function createRecord(mode='ai'){
 if(currentRole!=='consultant')throw new Error('请切换至咨询师视图新建咨询档案');
 if(creatingRecord||uploading||saving)throw new Error('正在接收或保存资料，请稍候。');creatingRecord=true;
 try{await flushEdits();notice('');const {record}=await api('/api/records',{mode});takeRecord(record);location.hash='record='+record.id;window.scrollTo({top:0,behavior:'instant'});await loadRows();schedulePoll();return record}finally{creatingRecord=false}
}
async function addFiles(fileList,target=null){
 if(currentRole!=='consultant'){toast('请从咨询师视图导入客户资料。');return}
 if(uploading||saving||creatingRecord)return;if(target&&active?.id===target&&isProcessing(active)){toast('本次资料正在整理，请完成后追加。');return}const candidates=Array.from(fileList);if(!candidates.length)return;
 const accepted=[],errors=[];for(const f of candidates){const audio=/\.(wav|mp3|m4a|aac|flac|ogg|amr)$/i.test(fileName(f));if(!/\.(jpe?g|png|webp|hei[cf]|txt|md|wav|mp3|m4a|aac|flac|ogg|amr)$/i.test(fileName(f))){errors.push(fileName(f)+'：不支持此格式');continue}const limit=audio?64:16;if(!f.size||f.size>limit*1024*1024){errors.push(fileName(f)+'：文件为空或超过'+limit+'MB');continue}accepted.push(f)}
 if(!accepted.length){toast(errors.join('；'));return}
 try{
  await flushEdits();if(!target)await createRecord();else if(active?.id!==target)await openRecord(target);
  const id=active.id;const room=8-active.files.length;if(accepted.length>room){errors.push('每次咨询最多8份资料，其余未添加');accepted.splice(Math.max(0,room))}
  if(!accepted.length){toast(errors.join('；'));return}
  uploading=true;renderEditor();let added=0;
  for(const file of accepted){try{const {record}=await api('/api/records/'+id+'/files',file,true,fileName(file));takeRecord(record);added++}catch(error){errors.push(error.message)}}
  uploading=false;
  if(added){const {record}=await api('/api/records/'+id+'/process',{});takeRecord(record);schedulePoll()}else renderEditor();
  await loadRows();if(errors.length)notice(errors.join('；'));
 }catch(error){uploading=false;notice(error.message);renderEditor()}
}
async function save(){
 if(currentRole!=='consultant'||!active||$('saveBtn').disabled)return;
 saving=true;renderEditor();notice('');
 try{await flushEdits();const fields=Object.fromEntries(Object.keys(active.fields).map(key=>[key,$('field-'+key).value]));saveOperation=saveOperation||crypto.randomUUID();const {record}=await api('/api/records/'+active.id+'/save',{fields,revision:active.savedRevision,operation:saveOperation,acknowledgements:acknowledged});dirtyFields={};takeRecord(record);backup();await loadRows();toast('档案已保存。原始材料、记录和待补信息一起留存。')}
 catch(error){notice(error.message)}finally{saving=false;renderEditor()}
}
function selectSource(index,refs=[],label=''){
 if(index!==inlineIndex){const file=active?.files[index];previewMode=file&&(file.mime.startsWith('image/')||file.mime.startsWith('audio/'))?'image':'text'}inlineIndex=index;inlineRefs=refs;inlineLabel=label;sourceAutoApplied=true;renderInlinePreview();
}
function viewEvidence(index,refs,label){
 if(window.matchMedia('(max-width:720px)').matches){showSources(index,refs);return}
 selectSource(index,refs,label);
}
function renderInlinePreview(){
 if(!active)return;const file=active.files[inlineIndex]||active.files[0];
 $('inlinePreview').hidden=!file;if(!file){stopMedia();return}inlineIndex=active.files.indexOf(file);
 for(const button of $('fileList').querySelectorAll('[data-file]')){const index=Number(button.dataset.file),selected=index===inlineIndex,referenced=inlineRefs.some(ref=>active.sources[ref]?.docIndex===index);button.closest('.file-card').classList.toggle('selected',selected);button.closest('.file-card').classList.toggle('has-evidence',referenced);button.setAttribute('aria-pressed',String(selected))}
 const busy=isProcessing(active)||uploading||saving;$('excludeSource').disabled=busy;$('excludeSource').textContent=file.excluded?'重新纳入':'移出本次';
 const hasImage=file.mime.startsWith('image/')&&file.status!=='error',hasAudio=file.mime.startsWith('audio/');if(!hasImage&&!hasAudio)previewMode='text';
 const key=JSON.stringify([file.id,file.status,file.excluded,file.lines.length,inlineRefs,inlineLabel,previewMode]);if(inlineRenderKey===key)return;inlineRenderKey=key;
 const quoted=inlineRefs.map(ref=>active.sources[ref]).filter(ref=>ref&&ref.docIndex===inlineIndex);
 $('inlineQuote').hidden=!quoted.length;$('inlineQuoteLabel').textContent=(inlineLabel?inlineLabel+' · ':'')+(hasAudio?'转写依据，请回听核对':'原文依据')+(new Set(inlineRefs.map(ref=>active.sources[ref]?.docIndex)).size>1?' · 引用多份资料':'');$('inlineQuoteText').textContent=quoted.map(ref=>ref.text).join('；');
 $('inlineFileName').textContent=file.name+(hasAudio&&file.duration?' · '+audioTime(file.duration):'');$('inlineFileName').title=file.name;
 for(const button of document.querySelectorAll('[data-preview-mode]')){const selected=button.dataset.previewMode===previewMode;button.classList.toggle('active',selected);button.setAttribute('aria-pressed',String(selected));button.disabled=button.dataset.previewMode==='image'&&!hasImage&&!hasAudio;if(button.dataset.previewMode==='image')button.textContent=hasAudio?'录音与转写':'原图';else button.textContent=hasAudio?'转写原文':'识别文字'}
 $('inlineImageWrap').hidden=!hasImage||previewMode!=='image';$('inlineAudioWrap').hidden=!hasAudio||previewMode!=='image';$('inlineText').hidden=previewMode!=='text';
 $('inlineText').textContent=file.lines.length?file.lines.map(line=>(line.start!=null?'['+audioTime(line.start)+'] ':'')+line.text).join('\n'):file.error||'识别或转写完成后会显示文字。';
 if(hasAudio){if(previewMode==='text')$('inlineAudio').pause();setupAudio($('inlineAudio'),file);$('inlineSegments').innerHTML=audioSegments(file);positionAudio($('inlineAudio'),quoted)}else $('inlineAudio').pause();
 const box=quoted.find(ref=>ref.box)?.box;
 const alignImage=()=>{const image=$('inlineImage'),mark=$('inlineMark');mark.hidden=!box;if(box){const width=image.clientWidth,height=image.clientHeight;Object.assign(mark.style,{left:box.x*width+'px',top:box.y*height+'px',width:box.width*width+'px',height:box.height*height+'px'});$('inlineImageWrap').scrollTop=Math.max(0,box.y*height-60)}else $('inlineImageWrap').scrollTop=0};
 $('inlineImage').onload=alignImage;
 if(hasImage){if($('inlineImage').getAttribute('src')!==file.url)$('inlineImage').src=file.url;if($('inlineImage').complete)requestAnimationFrame(alignImage)}
 if(previewMode==='text')$('inlineText').scrollTop=0;
}
$('expandSource').onclick=()=>showSources(inlineIndex,inlineRefs);
$('excludeSource').onclick=()=>{const file=active?.files[inlineIndex];if(file)toggleFile(file.id)};
for(const button of document.querySelectorAll('[data-preview-mode]'))button.onclick=()=>{previewMode=button.dataset.previewMode;renderInlinePreview()};
$('recordForm').addEventListener('focusin',event=>{const key=event.target.dataset.field,field=active?.fields[key];if(field?.refs.length&&!window.matchMedia('(max-width:720px)').matches)viewEvidence(active.sources[field.refs[0]]?.docIndex||0,field.refs,labels[key]||'基本信息')});
function showSources(index=0,refs=[]){if(!active?.files.length)return;stopMedia();sourceIndex=index;sourceRefs=refs;renderSources();$('sourceDialog').showModal()}
function renderSources(){
 const f=active.files[sourceIndex];if(!f)return;$('sourceTitle').textContent=f.name;
 $('sourceTabs').innerHTML=active.files.map((file,i)=>`<button class="${i===sourceIndex?'active':''}" data-source="${i}">资料 ${i+1}${file.excluded?' · 已移出':''}</button>`).join('');
 const quoted=sourceRefs.map(ref=>active.sources[ref]).filter(s=>s&&s.docIndex===sourceIndex),hasAudio=f.mime.startsWith('audio/');
 $('sourceQuote').hidden=!quoted.length;$('sourceQuote').textContent=quoted.map(s=>(hasAudio?'转写'+(s.start!=null?' ['+audioTime(s.start)+']':''):'原文')+'：'+s.text).join('\n');
 $('sourceImageWrap').hidden=!f.mime.startsWith('image/')||f.status==='error';$('sourceImage').src=f.mime.startsWith('image/')&&f.status!=='error'?f.url:'';
 $('sourceAudioWrap').hidden=!hasAudio;if(hasAudio){setupAudio($('sourceAudio'),f);$('sourceAudioSegments').innerHTML=audioSegments(f);positionAudio($('sourceAudio'),quoted)}else $('sourceAudio').pause();
 $('sourceText').textContent=f.lines.length?f.lines.map(l=>(l.start!=null?'['+audioTime(l.start)+'] ':'')+l.text).join('\n'):f.error||'识别或转写中，完成后会显示文字。';
 const box=quoted[0]?.box;$('sourceMark').hidden=!box;if(box){const scroll=()=>{const width=$('sourceImage').clientWidth,height=$('sourceImage').clientHeight;Object.assign($('sourceMark').style,{left:box.x*width+'px',top:box.y*height+'px',width:box.width*width+'px',height:box.height*height+'px'});$('sourceImageWrap').scrollTop=Math.max(0,box.y*height-50)};$('sourceImage').onload=scroll;if($('sourceImage').complete)scroll()}else{$('sourceImage').onload=null;$('sourceImageWrap').scrollTop=0}
}
async function toggleFile(id){
 if(!active||isProcessing(active)||uploading)return;try{await flushEdits();const {record}=await api('/api/records/'+active.id+'/toggle-file',{fileId:id});takeRecord(record);schedulePoll();notice('')}catch(error){notice(error.message)}
}
function showHelp(){
 $('infoTitle').textContent='从前期咨询，到店接诊';$('infoBody').innerHTML='<h3>三个岗位，同一份咨询档案</h3><p>咨询师导入截图、表单或录音并核对保存；前台按姓名、手机号或咨询编号查找，人工确认身份后登记到店；对应医生读取前期咨询摘要，面诊后单独填写接诊记录。</p><h3>录音在本机转写</h3><p>支持WAV、MP3、M4A等录音。原文件、带时间位置的转写文字一起保留，可回听核对。语音与结构化提取均在本机运行；转写没有自动区分说话人，也可能识别错词。</p><h3>当前共享范围</h3><p>这是同机同一服务的岗位视图原型，可以在多个浏览器标签中分别查看咨询师、前台和医生视图。岗位选择不等于员工账号登录；尚未部署跨设备访问和正式账号权限，也尚未连接门店消费档案系统。</p><h3>面诊与记录</h3><p>客户自述、咨询方介绍和医生记录分开。AI只整理已有咨询信息，不自动作出诊断或治疗决定。医生接诊记录单独保存，重新识别资料不会覆盖。</p><h3>资料保存</h3><p>原始资料、咨询档案与接诊记录保存在本机，可重新打开并回查依据。</p>';$('infoDialog').showModal();
}
function requestUpload(target){uploadTarget=target;$('fileInput').click()}
$('uploadHome').onclick=()=>requestUpload(null);$('addFiles').onclick=$('editorDrop').onclick=()=>requestUpload(active?.id);
$('fileInput').onchange=async event=>{const files=Array.from(event.target.files);event.target.value='';await addFiles(files,uploadTarget)};
$('manualBtn').onclick=async()=>{try{await createRecord('manual')}catch(error){notice(error.message)}};
$('homeBtn').onclick=()=>{recordFilter='all';home().catch(error=>notice(error.message))};$('backBtn').onclick=()=>home().catch(error=>notice(error.message));$('search').oninput=renderList;
for(const button of document.querySelectorAll('[data-nav-filter]'))button.onclick=()=>{recordFilter=button.dataset.navFilter;home().catch(error=>notice(error.message))};
document.querySelector('.brand').onclick=event=>{event.preventDefault();recordFilter='all';home().catch(error=>notice(error.message))};
$('recordList').onclick=event=>{const button=event.target.closest('[data-open]');if(button)openRecord(button.dataset.open).catch(error=>notice(error.message))};
document.querySelector('.filter-tabs').onclick=event=>{const button=event.target.closest('[data-filter]');if(button){recordFilter=button.dataset.filter;renderList()}};
$('recordForm').oninput=onEdit;$('recordForm').onsubmit=event=>event.preventDefault();$('saveBtn').onclick=save;
$('fileList').onclick=event=>{const file=event.target.closest('[data-file]'),toggle=event.target.closest('[data-toggle]');if(file){const index=Number(file.dataset.file);if(window.matchMedia('(max-width:720px)').matches)showSources(index,[]);else selectSource(index,[],'')}if(toggle)toggleFile(toggle.dataset.toggle)};
$('contentFields').onclick=event=>{const button=event.target.closest('[data-evidence]');if(button){const refs=active.fields[button.dataset.evidence].refs;const index=active.sources[refs[0]]?.docIndex||0;viewEvidence(index,refs,labels[button.dataset.evidence])}};
$('sourceTabs').onclick=event=>{const button=event.target.closest('[data-source]');if(button){sourceIndex=Number(button.dataset.source);renderSources()}};
$('checks').onchange=event=>{if(event.target.id==='identityAck')acknowledged.identity=event.target.checked;if(event.target.id==='partialAck')acknowledged.partial=event.target.checked;renderEditor()};
$('retryBtn').onclick=async()=>{if(!active)return;try{await flushEdits();const {record}=await api('/api/records/'+active.id+'/process',{});takeRecord(record);schedulePoll();notice('')}catch(error){notice(error.message)}};
$('helpBtn').onclick=showHelp;
for(const button of document.querySelectorAll('[data-close]'))button.onclick=()=>{stopMedia();$(button.dataset.close).close()};
$('sourceDialog').addEventListener('close',stopMedia);
for(const id of ['homeDrop','editorDrop']){const target=$(id);target.addEventListener('dragover',event=>{event.preventDefault();target.classList.add('dragover')});target.addEventListener('dragleave',()=>target.classList.remove('dragover'));target.addEventListener('drop',event=>{event.preventDefault();target.classList.remove('dragover');addFiles(event.dataTransfer.files,id==='editorDrop'?active?.id:null)})}
window.addEventListener('paste',event=>{const images=Array.from(event.clipboardData?.items||[]).filter(item=>item.kind==='file'&&item.type.startsWith('image/')).map(item=>item.getAsFile()).filter(Boolean);if(images.length){event.preventDefault();addFiles(images,active?.id||null)}});
window.addEventListener('beforeunload',event=>{if(Object.keys(dirtyFields).length){backup();event.preventDefault();event.returnValue=''}});
let resizeTimer=null;
window.addEventListener('resize',()=>{for(const element of document.querySelectorAll('#recordFields textarea'))if(element.getClientRects().length)fit(element);clearTimeout(resizeTimer);resizeTimer=setTimeout(()=>{if($('sourceDialog').open)renderSources();if(active){inlineRenderKey='';renderInlinePreview()}},100)});
async function init(){
 buildFields();try{const status=await api('/api/status');if(status.version!==7)throw new Error('当前打开的服务版本不正确');token=status.token;connected=true;installed=status.installed;$('connection').textContent=installed?'本机服务就绪':'本机模型未准备';if(!installed)notice('请双击“启动客户档案.command”完成本机模型准备。');await initRoleViews(status);}catch(error){$('connection').textContent='服务未连接';notice(error.message)}
}
init();
