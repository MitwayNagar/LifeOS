const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
const state = { tasks: [], goals: [], habits: [], weekly: [], stats: {}, today: '', month: new Date(), editingTask: null, timer: { mode: 'focus', total: 1500, remaining: 1500, running: false, interval: null } };
const dayNames = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
let toastTimeout;

async function api(url, options = {}) {
  const response = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...options });
  const data = response.status === 204 ? {} : await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Something went wrong. Please try again.');
  return data;
}
function notify(message, isError = false) {
  const el = $('#toast'); el.textContent = message; el.classList.toggle('error', isError); el.classList.add('show');
  clearTimeout(toastTimeout); toastTimeout = setTimeout(() => el.classList.remove('show'), 2800);
}
function esc(value = '') { return String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function dateText(value) { if (!value) return 'No deadline'; const d = new Date(value + 'T00:00:00'); return d.toLocaleDateString(undefined, { month:'short', day:'numeric' }); }
function statusLabel(status) { return ({todo:'To do',progress:'In progress',done:'Completed'})[status] || 'To do'; }
function taskMatches(t) {
  const query = ($('#taskSearch')?.value || '').trim().toLowerCase();
  const priority = $('#priorityFilter')?.value || 'all'; const category = $('#categoryFilter')?.value || 'all';
  return (!query || `${t.title} ${t.category} ${t.priority}`.toLowerCase().includes(query)) && (priority === 'all' || t.priority === priority) && (category === 'all' || t.category === category);
}
async function refresh() {
  try { const data = await api('/api/data'); Object.assign(state, data); renderAll(); }
  catch (e) { notify(e.message, true); }
}
function renderAll() { renderStats(); renderPriority(); renderBoard(); renderCalendar(); renderHabits(); renderAnalytics(); renderFocusStats(); }
function renderStats() {
  const s = state.stats; $('#statTotal').textContent = s.total_tasks; $('#statCompleted').textContent = s.completed_tasks; $('#statPending').textContent = `${s.pending_tasks} pending`;
  $('#completionRate').textContent = `${s.task_progress}%`; $('#statFocus').textContent = s.focus_minutes; $('#focusSessions').textContent = `${s.focus_sessions} all-time`;
  $('#statHabits').textContent = s.habits_done; $('#habitTotal').textContent = ` / ${s.habits_total}`; $('#navTaskCount').textContent = s.pending_tasks;
  $('#taskTrack').style.width = `${s.total_tasks ? Math.min(100, s.total_tasks * 5) : 0}%`; $('#completeTrack').style.width = `${s.task_progress}%`;
  $('#focusTrack').style.width = `${Math.min(100, s.focus_minutes / 120 * 100)}%`; $('#habitTrack').style.width = `${s.habits_total ? s.habits_done / s.habits_total * 100 : 0}%`;
  $('#sidebarProgress').textContent = `${s.task_progress}% of tasks completed`; $('.mini-progress i').style.width = `${s.task_progress}%`;
  const now = new Date(); $('#todayLabel').textContent = now.toLocaleDateString(undefined,{weekday:'short',month:'short',day:'numeric'}); $('#statsDate').textContent = now.toLocaleDateString(undefined,{month:'long',day:'numeric',year:'numeric'});
  const hour = now.getHours(); $('#greeting').innerHTML = `${hour < 12 ? 'Good morning' : hour < 17 ? 'Make this day' : 'Good evening'}<br><span>${hour < 12 ? 'make it count.' : hour < 17 ? 'count.' : 'end strong.'}</span>`;
}
function renderPriority() {
  const items = state.tasks.filter(t => t.status !== 'done').sort((a,b) => ({Urgent:0,High:1,Medium:2,Low:3}[a.priority] - ({Urgent:0,High:1,Medium:2,Low:3}[b.priority]))).slice(0,5);
  $('#priorityTasks').innerHTML = items.map(t => `<div class="priority-item"><button class="task-check" data-complete="${t.id}" title="Mark completed">${t.status==='done'?'✓':''}</button><div class="priority-item-main"><strong>${esc(t.title)}</strong><small>${esc(t.category)} · ${dateText(t.due_date)}</small></div><span class="priority-badge ${t.priority.toLowerCase()}">${esc(t.priority)}</span></div>`).join('');
  $('#emptyPriority').style.display = items.length ? 'none' : 'block';
  $('#weeklyChart').innerHTML = state.weekly.map(d => `<div class="week-day"><div class="week-bars"><i class="week-bar" style="height:${Math.max(3, Math.min(83,d.tasks*15))}px" title="${d.tasks} tasks"></i><i class="week-bar focus-bar" style="height:${Math.max(3,Math.min(83,d.focus/2))}px" title="${d.focus} focus minutes"></i></div><small>${d.label}</small></div>`).join('');
}
function cardHTML(t) { return `<article class="kanban-card" draggable="true" data-card="${t.id}"><h4>${esc(t.title)}</h4><div class="kanban-meta"><span class="priority-badge ${t.priority.toLowerCase()}">${esc(t.priority)}</span><small>${dateText(t.due_date)}</small></div><div class="card-bottom"><span class="card-category">${esc(t.category)}</span><div class="card-actions"><button class="tiny-button" data-edit="${t.id}" title="Edit task">✎</button><button class="tiny-button" data-delete-task="${t.id}" title="Delete task">×</button></div></div></article>`; }
function renderBoard() {
  const statuses = {todo:[],progress:[],done:[]}; state.tasks.filter(taskMatches).forEach(t => (statuses[t.status] || statuses.todo).push(t));
  [['todo','colTodo','countTodo'],['progress','colProgress','countProgress'],['done','colDone','countDone']].forEach(([status,col,count]) => { $(`#${col}`).innerHTML = statuses[status].map(cardHTML).join(''); $(`#${count}`).textContent = statuses[status].length; });
}
function renderCalendar() {
  const y = state.month.getFullYear(), m = state.month.getMonth(); $('#monthLabel').textContent = state.month.toLocaleDateString(undefined,{month:'long',year:'numeric'});
  const first = new Date(y,m,1), offset = (first.getDay()+6)%7, days = new Date(y,m+1,0).getDate(), prevDays = new Date(y,m,0).getDate(); let html = '';
  for (let i=0;i<42;i++) { let n, mm=m, yy=y, outside=false; if(i<offset){n=prevDays-offset+i+1;mm=m-1;outside=true;} else if(i>=offset+days){n=i-offset-days+1;mm=m+1;outside=true;} else n=i-offset+1;
    const d = new Date(yy,mm,n), key = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    const tasks = state.tasks.filter(t=>t.due_date===key).slice(0,2);
    html += `<div class="calendar-day ${outside?'outside':''} ${key===state.today?'today':''}"><span class="day-number">${n}</span>${tasks.map(t=>`<span class="day-task ${t.status}" title="${esc(t.title)}">${esc(t.title)}</span>`).join('')}</div>`;
  }
  $('#calendarGrid').innerHTML=html;
  const upcoming=state.tasks.filter(t=>t.due_date && t.due_date>=state.today && t.status!=='done').sort((a,b)=>a.due_date.localeCompare(b.due_date)).slice(0,6);
  $('#upcomingList').innerHTML=upcoming.length?upcoming.map(t=>{const d=new Date(t.due_date+'T00:00:00');return `<div class="upcoming-item"><div class="due-date-box"><strong>${d.getDate()}</strong><small>${d.toLocaleDateString(undefined,{month:'short'})}</small></div><div><strong>${esc(t.title)}</strong><small>${esc(t.category)} · ${statusLabel(t.status)}</small></div><span class="priority-badge ${t.priority.toLowerCase()}">${esc(t.priority)}</span></div>`}).join(''):'<div class="empty-state" style="display:block">No upcoming deadlines. Add due dates to your tasks.</div>';
}
function renderHabits() {
  const habits=state.habits, done=habits.filter(h=>h.done_today).length, pct=habits.length?Math.round(done/habits.length*100):0;
  $('#habitSummaryTitle').textContent=pct===100&&habits.length?'You showed up for yourself today ✨':'Consistency starts today'; $('#habitSummaryText').textContent=`${done} of ${habits.length} habits completed today.`; $('#habitSummaryPercent').textContent=`${pct}%`; $('#habitSummaryTrack').style.width=`${pct}%`;
  $('#habitsGrid').innerHTML=habits.length?habits.map(h=>`<article class="habit-card"><div class="habit-card-top"><div class="habit-symbol">✳</div><div><strong>${esc(h.title)}</strong><small>Daily habit</small></div><span class="habit-streak">🔥 ${h.streak} day${h.streak===1?'':'s'}</span></div><div class="habit-week">${h.week.map((v,i)=>`<div class="habit-week-day">${dayNames[(new Date().getDay()+i+1)%7]}<i class="${v?'done':''}">${v?'✓':'·'}</i></div>`).join('')}</div><div class="habit-card-actions"><button class="button ${h.done_today?'button-secondary':'button-primary'}" data-check-habit="${h.id}">${h.done_today?'✓ Completed today':'✓ Mark complete'}</button><button class="button button-secondary" data-delete-habit="${h.id}" title="Delete habit">×</button></div></article>`).join(''):'<div class="panel empty-state" style="display:block;grid-column:1/-1">No habits yet. Add one small daily habit to begin.</div>';
}
function renderAnalytics() {
  const s=state.stats; $('#anCompleted').textContent=s.completed_tasks; $('#anFocus').textContent=state.weekly.reduce((n,d)=>n+d.focus,0); $('#anRate').textContent=`${s.task_progress}%`; $('#anHabits').textContent=s.habits_total;
  $('#analyticsChart').innerHTML=state.weekly.map(d=>`<div class="analytics-bar-group"><div class="analytics-bar-track"><i class="analytics-bar" style="height:${Math.max(3,Math.min(145,d.tasks*22))}px" title="${d.tasks} completed tasks"></i></div><small>${d.label}</small></div>`).join('');
  const total=s.total_tasks||0, todo=state.tasks.filter(t=>t.status==='todo').length, progress=state.tasks.filter(t=>t.status==='progress').length, done=state.tasks.filter(t=>t.status==='done').length;
  const deg1=total?todo/total*360:0,deg2=total?(todo+progress)/total*360:0; $('#taskDonut').style.background=`conic-gradient(#a995ff 0deg ${deg1}deg,#69b6ff ${deg1}deg ${deg2}deg,#54d7a4 ${deg2}deg 360deg)`;
  $('#donutTotal').textContent=total; $('#legendTodo').textContent=todo; $('#legendProgress').textContent=progress; $('#legendDone').textContent=done;
}
function renderFocusStats(){ $('#focusTodayBig').textContent=`${state.stats.focus_minutes||0} min`; $('#focusSessionsBig').textContent=state.stats.focus_sessions||0; }
function openModal(id){const el=$(`#${id}`);el.hidden=false;const input=$('input',el);if(input)input.focus();}
function closeModal(id){$(`#${id}`).hidden=true;}
function setView(view){$$('.view').forEach(v=>v.classList.toggle('active-view',v.id===`view-${view}`));$$('.nav-item[data-view]').forEach(b=>b.classList.toggle('active',b.dataset.view===view));const names={overview:'Overview',board:'Kanban board',calendar:'Calendar',habits:'Habits',analytics:'Analytics',focus:'Focus timer'};$('#breadcrumbTitle').textContent=names[view]||'Overview';$('.sidebar').classList.remove('mobile-open');window.scrollTo({top:0,behavior:'smooth'});}
function setTimerMode(mode,minutes){pauseTimer();state.timer.mode=mode;state.timer.total=minutes*60;state.timer.remaining=minutes*60;$$('[data-mode]').forEach(b=>b.classList.toggle('selected',b.dataset.mode===mode&&Number(b.dataset.minutes)===minutes));updateTimerUI();}
function updateTimerUI(){const t=state.timer, m=Math.floor(t.remaining/60),s=t.remaining%60,txt=`${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;$('#miniTimer').textContent=txt;$('#largeTimer').textContent=txt;$('#timerStatus').textContent=t.running?'Stay with the moment':t.remaining===0?'Session complete':'Ready when you are';$('#timerOverline').textContent=t.mode==='focus'?'TIME TO FOCUS':'TIME TO RESET';$('#startTimer').textContent=t.running?'Ⅱ Pause timer':t.remaining===0?'↻ Start again':t.mode==='focus'?'▶ Start focus':'▶ Start break';$('#timerProgress').style.strokeDashoffset=729*(1-t.remaining/t.total);}
function pauseTimer(){if(state.timer.interval)clearInterval(state.timer.interval);state.timer.interval=null;state.timer.running=false;}
function startTimer(){if(state.timer.running){pauseTimer();updateTimerUI();return;}if(state.timer.remaining<=0)state.timer.remaining=state.timer.total;state.timer.running=true;updateTimerUI();state.timer.interval=setInterval(async()=>{state.timer.remaining--;if(state.timer.remaining<=0){pauseTimer();state.timer.remaining=0;updateTimerUI();try{await api('/api/focus',{method:'POST',body:JSON.stringify({mode:state.timer.mode,minutes:Math.max(1,Math.round(state.timer.total/60))})});await refresh();notify(state.timer.mode==='focus'?'Focus session saved. Great work!':'Break completed. Ready for another round?');}catch(e){notify(e.message,true);}return;}updateTimerUI();},1000);}
function openTaskModal(status='todo',task=null){state.editingTask=task?task.id:null;const form=$('#taskForm');form.reset();$('#taskModalTitle').textContent=task?'Edit task':'Create a task';if(task){form.elements.title.value=task.title;form.elements.category.value=task.category;form.elements.priority.value=task.priority;form.elements.due_date.value=task.due_date||'';form.elements.status.value=task.status;}else form.elements.status.value=status;openModal('taskModal');}

$$('.nav-item[data-view]').forEach(b=>b.addEventListener('click',()=>setView(b.dataset.view)));
$$('[data-jump]').forEach(b=>b.addEventListener('click',()=>setView(b.dataset.jump)));
$('#mobileMenu').addEventListener('click',()=>$('.sidebar').classList.toggle('mobile-open'));
$('#themeToggle').addEventListener('click',()=>{document.body.classList.toggle('light');localStorage.setItem('lifeos-theme',document.body.classList.contains('light')?'light':'dark');});
if(localStorage.getItem('lifeos-theme')==='light')document.body.classList.add('light');
['topAddTask','heroAddTask','boardAddTask'].forEach(id=>$('#'+id).addEventListener('click',()=>openTaskModal()));
$$('.add-column-task').forEach(b=>b.addEventListener('click',()=>openTaskModal(b.dataset.status)));
$$('[data-close]').forEach(b=>b.addEventListener('click',()=>closeModal(b.dataset.close)));
$$('.modal-backdrop').forEach(b=>b.addEventListener('click',e=>{if(e.target===b)closeModal(b.id);}));
$('#taskForm').addEventListener('submit',async e=>{e.preventDefault();const f=e.currentTarget;const body=Object.fromEntries(new FormData(f));try{if(state.editingTask)await api(`/api/tasks/${state.editingTask}`,{method:'PATCH',body:JSON.stringify(body)});else await api('/api/tasks',{method:'POST',body:JSON.stringify(body)});closeModal('taskModal');await refresh();notify(state.editingTask?'Task updated':'Task created');}catch(err){notify(err.message,true);}});
$('#habitForm').addEventListener('submit',async e=>{e.preventDefault();try{await api('/api/habits',{method:'POST',body:JSON.stringify({title:new FormData(e.currentTarget).get('title')})});e.currentTarget.reset();closeModal('habitModal');await refresh();notify('Habit created');}catch(err){notify(err.message,true);}});
$('#addHabitButton').addEventListener('click',()=>openModal('habitModal'));
$('#taskSearch').addEventListener('input',renderBoard);$('#priorityFilter').addEventListener('change',renderBoard);$('#categoryFilter').addEventListener('change',renderBoard);
$('#prevMonth').addEventListener('click',()=>{state.month.setMonth(state.month.getMonth()-1);renderCalendar();});$('#nextMonth').addEventListener('click',()=>{state.month.setMonth(state.month.getMonth()+1);renderCalendar();});
$$('[data-minutes]').forEach(b=>b.addEventListener('click',()=>setTimerMode(b.dataset.mode,Number(b.dataset.minutes))));
$('#startTimer').addEventListener('click',startTimer);$('#resetTimer').addEventListener('click',()=>{pauseTimer();state.timer.remaining=state.timer.total;updateTimerUI();});$('#skipTimer').addEventListener('click',()=>{pauseTimer();state.timer.remaining=0;updateTimerUI();notify('Timer skipped. Start a new session whenever you are ready.');});

document.addEventListener('click',async e=>{
  const complete=e.target.closest('[data-complete]');if(complete){try{await api(`/api/tasks/${complete.dataset.complete}`,{method:'PATCH',body:JSON.stringify({status:'done'})});await refresh();notify('Task completed!');}catch(err){notify(err.message,true);}return;}
  const edit=e.target.closest('[data-edit]');if(edit){const t=state.tasks.find(t=>t.id===Number(edit.dataset.edit));if(t)openTaskModal(t.status,t);return;}
  const del=e.target.closest('[data-delete-task]');if(del){if(!confirm('Delete this task?'))return;try{await api(`/api/tasks/${del.dataset.deleteTask}`,{method:'DELETE'});await refresh();notify('Task deleted');}catch(err){notify(err.message,true);}return;}
  const check=e.target.closest('[data-check-habit]');if(check){try{await api(`/api/habits/${check.dataset.checkHabit}/check`,{method:'POST'});await refresh();notify('Habit check-in updated');}catch(err){notify(err.message,true);}return;}
  const dh=e.target.closest('[data-delete-habit]');if(dh){if(!confirm('Delete this habit and its history?'))return;try{await api(`/api/habits/${dh.dataset.deleteHabit}`,{method:'DELETE'});await refresh();notify('Habit deleted');}catch(err){notify(err.message,true);}}
});
let draggedId=null;
document.addEventListener('dragstart',e=>{const card=e.target.closest('[data-card]');if(card){draggedId=Number(card.dataset.card);card.classList.add('dragging');e.dataTransfer.effectAllowed='move';e.dataTransfer.setData('text/plain',String(draggedId));}});
document.addEventListener('dragend',e=>{const card=e.target.closest('[data-card]');if(card)card.classList.remove('dragging');$$('.kanban-column').forEach(c=>c.classList.remove('drag-over'));});
$$('.kanban-column').forEach(col=>{col.addEventListener('dragover',e=>{e.preventDefault();col.classList.add('drag-over');});col.addEventListener('dragleave',e=>{if(!col.contains(e.relatedTarget))col.classList.remove('drag-over');});col.addEventListener('drop',async e=>{e.preventDefault();col.classList.remove('drag-over');const id=Number(e.dataTransfer.getData('text/plain'))||draggedId;if(!id)return;try{await api(`/api/tasks/${id}`,{method:'PATCH',body:JSON.stringify({status:col.querySelector('.kanban-cards').dataset.status})});await refresh();notify('Task moved');}catch(err){notify(err.message,true);}});});

refresh();setTimerMode('focus',25);
