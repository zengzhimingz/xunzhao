'use strict';
const roleLabels={consultant:'咨询师',frontdesk:'前台',doctor:'医生'};
const channelLabels={unspecified:'未标注',online:'线上',phone:'电话',offline:'线下',mixed:'多渠道'};
const visitLabels={waiting:'待接诊',in_consultation:'接诊中',completed:'已完成',cancelled:'已撤销'};
let currentRole=new URLSearchParams(location.search).get('role')||'consultant';
if(!roleLabels[currentRole])currentRole='consultant';
let currentDoctor=new URLSearchParams(location.search).get('doctor')||'doctor-a';
if(!['doctor-a','doctor-b'].includes(currentDoctor))currentDoctor='doctor-a';
let asrAvailable=false,sharedVisits=[],arrivalMatches=[],arrivalSelection=null,checkinOperation=null;
let sharedPoll=null,sharedBusy=false,visitFilter='active',selectedVisit=null,doctorRecord=null,doctorDraft='',doctorDirty=false;
let doctorConflict=null;
let doctorBaseRevision=null,doctorDetailKey='',sharedRequest=0,doctorPollBusy=false,matchQuery='',doctorSaveBusy=false;
const visitBadge=status=>`<span class="visit-badge ${esc(status)}"><span class="dot"></span>${visitLabels[status]||status}</span>`;
const maskedPhone=value=>String(value||'').replace(/^(\d{3})\d{4}(\d{4})$/,'$1****$2')||'未提供手机号';
const audioTime=value=>{const n=Math.max(0,Math.floor(Number(value)||0));return String(Math.floor(n/60)).padStart(2,'0')+':'+String(n%60).padStart(2,'0')};
function stopMedia(){for(const audio of document.querySelectorAll('audio'))audio.pause()}
function backupDoctor(){if(!selectedVisit)return;try{localStorage.setItem('care-doctor-draft:'+selectedVisit.id,JSON.stringify({text:doctorDraft,revision:doctorBaseRevision,dirty:doctorDirty}))}catch{}}
function roleUrl(role=currentRole,doctor=currentDoctor){const url=new URL(location.href);url.searchParams.set('role',role);if(role==='doctor')url.searchParams.set('doctor',doctor);else url.searchParams.delete('doctor');url.hash='';return url.pathname+url.search}
function setRoleUI(){
 document.body.dataset.role=currentRole;$('roleSelect').value=currentRole;$('doctorIdentity').hidden=currentRole!=='doctor';$('doctorIdentity').value=currentDoctor;
 document.querySelector('.operator>div').innerHTML=roleLabels[currentRole]+'工作台<small>同机岗位视图演示</small>';
 for(const id of ['homeView','editorView','arrivalView','doctorView'])$(id).hidden=true;
 $('pageLabel').textContent=currentRole==='consultant'?'咨询档案':currentRole==='frontdesk'?'到店匹配':'接诊交接';
 $('notice').hidden=true;clearTimeout(toastTimer);$('toast').classList.remove('visible');stopMedia();for(const dialog of document.querySelectorAll('dialog[open]'))dialog.close();
}
async function changeRole(role,doctor=currentDoctor){
 if(uploading||saving||creatingRecord||doctorSaveBusy||sharedBusy){toast('正在上传或保存，请稍候。');$('roleSelect').value=currentRole;$('doctorIdentity').value=currentDoctor;return}
 try{await flushEdits();backupDoctor();clearTimeout(sharedPoll);clearTimeout(pollTimer);clearTimeout(listPoll);currentRole=role;currentDoctor=doctor;sharedRequest++;active=null;renderedId=null;selectedVisit=null;doctorRecord=null;doctorDirty=false;doctorConflict=null;doctorDraft='';doctorDetailKey='';arrivalSelection=null;arrivalMatches=[];checkinOperation=null;$('checkinPanel').hidden=true;$('arrivalMatches').innerHTML='<div class="workflow-empty">'+icon('search')+'<strong>先查找前期咨询档案</strong><p>客户未消费，也可以拥有咨询档案。</p></div>';$('doctorDetail').innerHTML='<div class="workflow-empty">'+icon('clinic')+'<strong>选择一位到店客户</strong><p>咨询资料、原始依据和本次接诊记录在这里汇合。</p></div>';history.replaceState(null,'',roleUrl());setRoleUI();await showRoleHome()}catch(error){notice(error.message)}
}
async function showRoleHome(){
 if(currentRole==='consultant'){await home();return}
 $('homeView').hidden=true;$('editorView').hidden=true;$('arrivalView').hidden=currentRole!=='frontdesk';$('doctorView').hidden=currentRole!=='doctor';document.body.dataset.view=currentRole;
 $('pageLabel').textContent=currentRole==='frontdesk'?'到店匹配':'接诊交接';window.scrollTo({top:0,behavior:'instant'});await refreshShared();
}
async function initRoleViews(status){
 asrAvailable=!!status.asrReady;$('uploadAudioHome').disabled=!asrAvailable;
 if(!asrAvailable)$('uploadAudioHome').title='请先运行准备本机语音.py';
 $('roleSelect').onchange=event=>changeRole(event.target.value).catch(error=>notice(error.message));
 $('doctorIdentity').onchange=event=>changeRole('doctor',event.target.value).catch(error=>notice(error.message));
 $('frontdeskNav').onclick=$('doctorNav').onclick=()=>showRoleHome().catch(error=>notice(error.message));
 $('uploadAudioHome').onclick=()=>{uploadTarget=null;$('audioInput').click()};
 $('audioInput').onchange=async event=>{const files=Array.from(event.target.files);event.target.value='';await addFiles(files,uploadTarget)};
 $('handoffStatus').onclick=async event=>{if(event.target.closest('[data-enter-arrival]')&&active){const code=active.id.slice(0,8).toUpperCase();await changeRole('frontdesk');$('arrivalQuery').value=code;await findArrival()}};
 $('recordChannel').onchange=async event=>{if(!active)return;const channel=event.target.value;try{await flushEdits();const {record}=await api('/api/records/'+active.id+'/channel',{channel});takeRecord(record)}catch(error){notice(error.message)}};
 $('arrivalSearchForm').onsubmit=event=>{event.preventDefault();findArrival()};
 $('arrivalMatches').onclick=event=>{const button=event.target.closest('[data-select-arrival]');if(button){arrivalSelection=arrivalMatches.find(row=>row.id===button.dataset.selectArrival);checkinOperation=crypto.randomUUID();$('arrivalIdentityAck').checked=false;renderArrivalMatches()}};
 $('arrivalIdentityAck').onchange=()=>{$('checkinBtn').disabled=!arrivalSelection?.ready||!!arrivalSelection?.activeVisitId||!$('arrivalIdentityAck').checked||sharedBusy};
 $('checkinBtn').onclick=confirmArrival;
 $('frontdeskQueue').onclick=event=>{const button=event.target.closest('[data-cancel-visit]');if(button)cancelArrival(button.dataset.cancelVisit)};
 $('doctorQueue').onclick=event=>{const button=event.target.closest('[data-open-visit]');if(button)openVisit(button.dataset.openVisit)};
 document.querySelector('.visit-filters').onclick=event=>{const button=event.target.closest('[data-visit-filter]');if(button){visitFilter=button.dataset.visitFilter;renderDoctorQueue()}};
 $('doctorDetail').onclick=event=>{const draftAction=event.target.closest('[data-draft-action]');if(draftAction){resolveDoctorDraft(draftAction.dataset.draftAction);return}const action=event.target.closest('[data-visit-action]'),source=event.target.closest('[data-doctor-source]');if(action)actOnVisit(action.dataset.visitAction);if(source&&active){const key=source.dataset.doctorSource,refs=active.fields[key].refs;showSources(active.sources[refs[0]]?.docIndex||0,refs)}};
 $('doctorDetail').oninput=event=>{if(event.target.id==='clinicalNote'){doctorDraft=event.target.value;doctorDirty=true;backupDoctor();const hint=$('clinicalSaveHint');if(hint)hint.textContent='本次输入尚未保存到共享接诊记录';}};
 for(const id of ['inlineSegments','sourceAudioSegments'])$(id).onclick=event=>{const button=event.target.closest('[data-audio-seek]');if(button){const player=id==='inlineSegments'?$('inlineAudio'):$('sourceAudio');player.currentTime=Number(button.dataset.audioSeek);player.play().catch(()=>toast('请点击播放器播放原录音。'))}};
 window.addEventListener('beforeunload',event=>{if(doctorDirty){backupDoctor();event.preventDefault();event.returnValue=''}});
 setRoleUI();
 if(currentRole==='consultant'){$('homeView').hidden=false;await loadRows();const match=location.hash.match(/^#record=([a-f0-9]{32})$/);if(match)await openRecord(match[1]);else document.body.dataset.view='home';sharedPoll=setTimeout(refreshShared,4000)}else await showRoleHome();
}
async function findArrival(){
 const query=$('arrivalQuery').value.trim();if(sharedBusy)return;const request=++sharedRequest;matchQuery=query;arrivalSelection=null;checkinOperation=null;$('checkinPanel').hidden=true;$('arrivalSearchBtn').disabled=true;notice('');
 try{const {matches}=await api('/api/arrival/lookup?q='+encodeURIComponent(query));if(currentRole!=='frontdesk'||request!==sharedRequest)return;arrivalMatches=matches;renderArrivalMatches()}catch(error){notice(error.message);arrivalMatches=[];renderArrivalMatches()}finally{$('arrivalSearchBtn').disabled=false}
}
function renderArrivalMatches(){
 $('arrivalMatches').innerHTML=arrivalMatches.length?'<p class="results-count">找到 '+arrivalMatches.length+' 份候选档案，请人工核对</p>'+arrivalMatches.map(row=>`<button class="match-card ${arrivalSelection?.id===row.id?'selected':''}" data-select-arrival="${row.id}" ${!row.ready||row.activeVisitId?'disabled':''}><span class="match-avatar">${icon('user')}</span><span class="match-body"><strong>${esc(row.name)}</strong><span>${esc(maskedPhone(row.phone))} · 咨询编号 ${row.code}</span><small>${esc(row.need||'尚未填写客户诉求')}</small><em>${esc(row.matchReason)} · ${channelLabels[row.channel]||'未标注'}咨询</em></span><span class="match-state">${row.activeVisitId?'已在接诊队列':row.ready?'选择客户':'需咨询师先保存'}</span></button>`).join(''):'<div class="workflow-empty">'+icon('search')+'<strong>没有找到候选档案</strong><p>请核对姓名、手机号或咨询编号。没有前期记录时，可切换咨询师视图新建。</p></div>';
 $('checkinPanel').hidden=!arrivalSelection;
 if(arrivalSelection){$('selectedArrival').textContent=arrivalSelection.name+' · '+maskedPhone(arrivalSelection.phone)+' · 编号 '+arrivalSelection.code;$('checkinBtn').disabled=!arrivalSelection.ready||!!arrivalSelection.activeVisitId||!$('arrivalIdentityAck').checked||sharedBusy}
}
async function confirmArrival(){
 if(!arrivalSelection||$('checkinBtn').disabled)return;sharedBusy=true;$('checkinBtn').disabled=true;notice('');
 try{await api('/api/visits/checkin',{recordId:arrivalSelection.id,doctorId:$('assignDoctor').value,identityConfirmed:$('arrivalIdentityAck').checked,operation:checkinOperation});toast('已确认到店，交接单已进入对应医生队列。');arrivalSelection=null;$('checkinPanel').hidden=true;await refreshShared();sharedBusy=false;if(matchQuery)await findArrival()}catch(error){notice(error.message)}finally{sharedBusy=false;renderArrivalMatches()}
}
async function cancelArrival(id){
 const visit=sharedVisits.find(v=>v.id===id);if(!visit||sharedBusy)return;sharedBusy=true;
 try{await api('/api/visits/'+id+'/cancel',{revision:visit.revision});toast('到店登记已撤销，原咨询档案保留。');await refreshShared();sharedBusy=false;if(matchQuery)await findArrival()}catch(error){notice(error.message)}finally{sharedBusy=false}
}
async function refreshArrivalCandidates(){
 if(!matchQuery||$('arrivalQuery').value.trim()!==matchQuery)return;
 const query=matchQuery,request=sharedRequest,{matches}=await api('/api/arrival/lookup?q='+encodeURIComponent(query));
 if(currentRole!=='frontdesk'||request!==sharedRequest||query!==matchQuery||sharedBusy)return;
 if(JSON.stringify(matches)===JSON.stringify(arrivalMatches))return;
 const previous=arrivalSelection,fresh=previous?matches.find(row=>row.id===previous.id):null;
 arrivalMatches=matches;arrivalSelection=fresh&&!fresh.activeVisitId?fresh:null;
 if(!fresh||!previous||fresh.name!==previous.name||fresh.phone!==previous.phone||fresh.ready!==previous.ready||fresh.updatedAt!==previous.updatedAt)$('arrivalIdentityAck').checked=false;
 renderArrivalMatches();
}
function resolveDoctorDraft(action){
 if(!doctorConflict||!selectedVisit||!doctorRecord)return;
 doctorBaseRevision=doctorConflict.revision;
 if(action==='latest'){doctorDraft=doctorConflict.note;doctorDirty=false}else doctorDirty=true;
 doctorConflict=null;notice('');backupDoctor();applyDoctorDetail({visit:selectedVisit,record:doctorRecord},true);
 toast(action==='latest'?'已采用最新保存记录。':'已保留你的草稿，请核对、补充后保存。');
}
async function refreshShared(schedule=true){
 clearTimeout(sharedPoll);if(currentRole==='consultant'){await syncConsultant(schedule);return;}const role=currentRole,doctor=currentDoctor;
 try{const {visits}=await api('/api/visits');if(role!==currentRole||doctor!==currentDoctor)return;sharedVisits=visits;role==='frontdesk'?renderFrontdeskQueue():renderDoctorQueue();if(role==='frontdesk'&&!sharedBusy)await refreshArrivalCandidates();if(role==='doctor'&&selectedVisit&&!doctorDirty&&!doctorSaveBusy&&!doctorPollBusy){doctorPollBusy=true;try{const detail=await api('/api/visits/'+selectedVisit.id);if(currentRole===role&&selectedVisit?.id===detail.visit.id)applyDoctorDetail(detail,false)}finally{doctorPollBusy=false}}}catch(error){notice(error.message)}
 if(schedule&&currentRole!=='consultant')sharedPoll=setTimeout(refreshShared,3500);
}
function renderFrontdeskQueue(){
 const counts={waiting:0,in_consultation:0,completed:0};for(const visit of sharedVisits)if(visit.status in counts)counts[visit.status]++;
 $('frontdeskCounts').innerHTML=Object.entries(counts).map(([key,value])=>`<div><span>${visitLabels[key]}</span><strong>${value}</strong></div>`).join('');
 const visible=sharedVisits.filter(v=>v.status!=='cancelled').slice(0,30);
 $('frontdeskQueue').innerHTML=visible.length?visible.map(visit=>`<div class="frontdesk-visit"><div><strong>${esc(visit.customer.name)}</strong><span>${visit.customer.code} · ${esc(visit.doctorName)}</span><small>${date(visit.arrivedAt)} 到店</small></div><div>${visitBadge(visit.status)}${visit.status==='waiting'?`<button class="text-button" data-cancel-visit="${visit.id}">撤销登记</button>`:''}</div></div>`).join(''):'<div class="workflow-empty">'+icon('arrival')+'<strong>还没有到店登记</strong><p>确认客户身份后，接诊进度会出现在这里。</p></div>';
}
function renderDoctorQueue(){
 const filtered=sharedVisits.filter(v=>visitFilter==='active'?['waiting','in_consultation'].includes(v.status):v.status==='completed');
 $('doctorQueueCount').textContent=filtered.length;
 for(const button of document.querySelectorAll('[data-visit-filter]')){const selected=button.dataset.visitFilter===visitFilter;button.classList.toggle('active',selected);button.setAttribute('aria-pressed',String(selected))}
 $('doctorQueue').innerHTML=filtered.length?filtered.map(visit=>`<button class="doctor-queue-card ${selectedVisit?.id===visit.id?'selected':''}" data-open-visit="${visit.id}"><span class="queue-card-top"><strong>${esc(visit.customer.name)}</strong>${visitBadge(visit.status)}</span><span>${esc(visit.customer.need||'未填写诉求')}</span><small>${visit.customer.code} · ${date(visit.arrivedAt)} 到店</small></button>`).join(''):'<div class="workflow-empty">'+icon('inbox')+'<strong>'+(visitFilter==='active'?'暂无待接诊客户':'暂无已完成接诊')+'</strong><p>前台分配给当前医生的客户，会自动出现在这里。</p></div>';
}
async function openVisit(id){
 backupDoctor();notice('');try{const detail=await api('/api/visits/'+id);doctorDetailKey='';doctorDirty=false;doctorConflict=null;doctorDraft=detail.visit.note;doctorBaseRevision=detail.visit.revision;selectedVisit=detail.visit;try{const draft=JSON.parse(localStorage.getItem('care-doctor-draft:'+id)||'null');if(draft?.dirty&&detail.visit.status==='in_consultation'){doctorDraft=draft.text;doctorDirty=true;doctorBaseRevision=draft.revision;if(draft.revision!==detail.visit.revision)doctorConflict={revision:detail.visit.revision,note:detail.visit.note};toast(doctorConflict?'已有其他页面保存更新，请先比较两份记录。':'已恢复本机尚未保存的接诊输入，请核对后保存。')}}catch{}applyDoctorDetail(detail,true);renderDoctorQueue();if(matchMedia('(max-width:720px)').matches)$('doctorDetail').scrollIntoView({block:'start',behavior:'smooth'})}catch(error){notice(error.message)}
}
function applyDoctorDetail(detail,force){
 const key=JSON.stringify([detail.visit,detail.record.updatedAt,detail.record.status,detail.consultationHasDraft,detail.consultationUpdated]);if(!force&&key===doctorDetailKey)return;doctorDetailKey=key;
 selectedVisit=detail.visit;doctorRecord=detail.record;active=detail.record;if(!doctorDirty){doctorDraft=detail.visit.note;doctorBaseRevision=detail.visit.revision}
 const record=detail.record,visit=detail.visit;
 const field=key=>{const item=record.fields[key];return `<section class="handoff-field"><div><h3>${labels[key]}</h3>${item.refs.length?`<button class="text-button" data-doctor-source="${key}">${icon('quote')}查看依据</button>`:''}</div><p class="${item.text?'':'missing-value'}">${esc(item.text||'咨询材料未提供，面诊时按需核实')}</p>${item.modified?'<small>咨询师人工核对 / 补充</small>':''}</section>`};
 $('doctorDetail').innerHTML=`<div class="doctor-detail-heading"><div><span class="document-label">到店交接单 · ${record.id.slice(0,8).toUpperCase()}</span><h2>${esc(record.fields.name.text||'客户 · '+record.id.slice(0,6).toUpperCase())}</h2><p>${esc(maskedPhone(record.fields.phone.text))} · ${channelLabels[record.channel]||'未标注'}咨询 · ${esc(visit.doctorName)}</p></div>${visitBadge(visit.status)}</div><div class="clinical-context">${icon('shield')}<span>以下为前期咨询信息，客户自述与咨询方介绍供面诊核实。专业判断由接诊医生完成。</span></div>${detail.consultationHasDraft?'<div class="consultation-update">咨询档案有尚未保存的修改，请与咨询师核对最新内容。</div>':detail.consultationUpdated?'<div class="consultation-update">咨询师在到店登记后更新了资料，当前显示最新已保存内容。</div>':''}<div class="handoff-fields">${['need','history','progress','pricing','appointment','notes'].filter(key=>key!=='notes'||record.fields.notes.text).map(field).join('')}</div><section class="clinical-record"><div><h3>本次医生接诊记录</h3><span>与AI咨询摘要分开保存</span></div>${visit.status==='waiting'?'<p class="clinical-placeholder">开始接诊后，由医生记录面诊核实结果与后续安排。</p>':`<label for="clinicalNote" class="sr-only">医生接诊记录</label><textarea id="clinicalNote" maxlength="5000" rows="5" ${visit.status!=='in_consultation'?'readonly':''} placeholder="由医生填写本次面诊核实结果、沟通结论及后续安排。AI不会自动生成诊断。">${esc(doctorDraft)}</textarea>`}${doctorConflict?`<div class="doctor-conflict"><strong>其他页面已保存更新，请先核对</strong><p>上方保留你的未保存草稿，下方为最新已保存记录。</p><pre>${esc(doctorConflict.note||'最新记录为空')}</pre><div><button class="secondary" data-draft-action="latest">采用最新已保存记录</button><button class="secondary" data-draft-action="mine">保留我的草稿继续编辑</button></div></div>`:''}<div class="clinical-actions"><span id="clinicalSaveHint">${doctorDirty?'本次输入尚未保存到共享接诊记录':visit.status==='completed'?'接诊记录已留存':visit.note?'接诊记录已保存':'原始咨询记录保留，可按需回查'}</span>${visit.status==='waiting'?'<button class="primary" data-visit-action="start">开始接诊</button>':visit.status==='in_consultation'?'<button class="secondary" data-visit-action="note" '+(doctorConflict?'disabled':'')+'>保存接诊记录</button><button class="primary" data-visit-action="complete" '+(doctorConflict?'disabled':'')+'>完成本次接诊</button>':''}</div></section><details class="visit-timeline"><summary>交接与接诊时间线</summary>${visit.events.map(event=>`<div><span>${date(event.at)}</span><strong>${esc(event.action)}</strong><small>${roleLabels[event.role]||event.role}</small></div>`).join('')}</details>`;
}
async function actOnVisit(action){
 if(!selectedVisit||doctorSaveBusy||doctorConflict)return;doctorSaveBusy=true;notice('');const id=selectedVisit.id;
 const input=$('clinicalNote');if(input)doctorDraft=input.value;
 for(const button of $('doctorDetail').querySelectorAll('[data-visit-action]'))button.disabled=true;
 try{const {visit}=await api('/api/visits/'+id+'/'+action,{revision:doctorBaseRevision,note:doctorDraft});selectedVisit=visit;if(action==='complete')visitFilter='completed';doctorDirty=false;doctorConflict=null;doctorDraft=visit.note;doctorBaseRevision=visit.revision;backupDoctor();const detail=await api('/api/visits/'+id);applyDoctorDetail(detail,true);await refreshShared();toast(action==='start'?'已开始接诊，前台同步可见。':action==='complete'?'接诊已完成，医生记录已保存。':'医生接诊记录已保存。')}catch(error){notice(error.message);if(/已有更新/.test(error.message)){try{const detail=await api('/api/visits/'+id);if(selectedVisit?.id===id){doctorConflict={revision:detail.visit.revision,note:detail.visit.note};applyDoctorDetail(detail,true);notice('其他页面已保存更新，请比较两份内容后选择如何继续。');backupDoctor()}}catch{}}}finally{doctorSaveBusy=false;for(const button of $('doctorDetail').querySelectorAll('[data-visit-action]'))button.disabled=!!doctorConflict}
}
function audioSegments(file){return (file.lines||[]).filter(line=>line.start!=null).map(line=>`<button type="button" data-audio-seek="${Number(line.start)}"><time>${audioTime(line.start)}</time><span>${esc(line.text)}</span></button>`).join('')}
function setupAudio(player,file){const url=file.playbackUrl||file.url;if(player.getAttribute('src')!==url){player.pause();player.src=url}}
function positionAudio(player,refs){const item=refs.find(ref=>ref?.start!=null);if(!item)return;const seek=()=>{try{player.currentTime=Math.max(0,Number(item.start)-.4)}catch{}};player.onloadedmetadata=seek;if(player.readyState>=1)seek()}

async function syncConsultant(schedule=true){
 if(currentRole!=='consultant')return;
 try{if(!uploading&&!saving){const {records}=await api('/api/records');if(currentRole!=='consultant')return;rows=records;renderList();if(active&&!isProcessing(active)&&!Object.keys(dirtyFields).length){const id=active.id,{record}=await api('/api/records/'+id);if(currentRole==='consultant'&&active?.id===id&&(active.updatedAt!==record.updatedAt||JSON.stringify(active.visits)!==JSON.stringify(record.visits)))takeRecord(record)}}}catch(error){notice(error.message)}
 if(schedule&&currentRole==='consultant')sharedPoll=setTimeout(refreshShared,4000);
}
function renderHandoffStatus(){
 if(!active)return;const visit=active.visits?.[0],ready=active.status==='saved'&&!active.dirty&&!uploading&&!isProcessing(active);
 $('handoffStatus').hidden=false;$('handoffStatus').innerHTML='<div><strong>'+(visit?visitLabels[visit.status]+' · '+esc(visit.doctorName):ready?'可用于到店匹配':'核对保存后，可用于到店匹配')+'</strong><small>咨询编号 '+active.id.slice(0,8).toUpperCase()+' · 无需先消费建档'+(active.files.some(file=>file.mime.startsWith('audio/'))?' · 含通话录音':'')+'</small></div>'+(ready&&(!visit||['completed','cancelled'].includes(visit.status))?'<button class="text-button" data-enter-arrival>前台到店匹配 '+icon('arrow')+'</button>':'');
}
