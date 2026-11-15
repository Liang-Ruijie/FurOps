'use client';
import {useCallback,useEffect,useState} from 'react';
import Shell from '@/components/Shell';
import {Empty,Field,Modal,Notice,PageHeader} from '@/components/UI';
import {Select} from '@/components/Filters';
import {useIsDesktop} from '@/lib/useIsDesktop';
import {api,type Cat,type Litter,type CatDetail} from '@/lib/api';
const today=()=>new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai'}).format(new Date());
const roleLabel=(r:string)=>r==='mother'?'母猫':r==='male'?'公猫':'小猫';
function age(date:string|null){if(!date)return '未填写';const days=Math.max(0,Math.floor((Date.parse(today())-Date.parse(date))/86400000));return days<60?days+' 天':days<365?Math.floor(days/30)+' 个月':Math.floor(days/365)+' 岁';}
type Editor={kind:'cat';cat?:Cat}|{kind:'litter'}|{kind:'health';cat:Cat};
export default function CatsPage(){
 const desktop=useIsDesktop();const[highlighted,setHighlighted]=useState('');const[cats,setCats]=useState<Cat[]>([]);const[litters,setLitters]=useState<Litter[]>([]);const[loading,setLoading]=useState(true);const[error,setError]=useState('');const[message,setMessage]=useState('');const[editor,setEditor]=useState<Editor|null>(null);const[view,setView]=useState<Cat|null>(null);
 const refresh=useCallback(async()=>{try{const[c,l]=await Promise.all([api.cats(),api.litters()]);setCats(c);setLitters(l);setError('');}catch(e){setError((e as Error).message||'猫咪资料暂时无法加载，请重试');}finally{setLoading(false);}},[]);
 useEffect(()=>{refresh();},[refresh]);
 useEffect(()=>{const locate=()=>{const id=decodeURIComponent(window.location.hash.slice(1));setHighlighted(id);if(!loading&&id)document.getElementById(id)?.scrollIntoView({block:'center'});};locate();window.addEventListener('hashchange',locate);return()=>window.removeEventListener('hashchange',locate);},[loading,cats]);
 useEffect(()=>{if(!message)return;const timer=setTimeout(()=>setMessage(''),4000);return()=>clearTimeout(timer);},[message]);
 const done=()=>{setEditor(null);setMessage('资料已保存');refresh();};
 function card(c:Cat){return <article className="card entity-card" id={'cat-'+c.id} data-highlighted={highlighted==='cat-'+c.id} key={c.id}><div className="cat-head"><span className="avatar" aria-hidden="true">{c.name.slice(0,1)}</span><div className="grow"><div className="card-title"><h2>{c.name}</h2><span className="pill">{roleLabel(c.role)}</span></div><small>{[c.sex,c.birthDate?age(c.birthDate):null].filter(Boolean).join(' · ')||'资料待完善'}</small></div></div><dl className="kv-grid"><div><dt>最新体重</dt><dd>{c.latestWeight==null?'暂无记录':c.latestWeight+' 克'}</dd></div><div><dt>已记录费用</dt><dd>{c.costRecordCount>0?'¥'+(c.costFen/100).toFixed(2):'暂无费用记录'}</dd></div></dl><footer className="card-footer"><button onClick={()=>setView(c)}>查看详情</button>{desktop&&<><button onClick={()=>setEditor({kind:'health',cat:c})}>健康登记</button><button onClick={()=>setEditor({kind:'cat',cat:c})}>编辑资料</button></>}</footer></article>;}
 return <Shell><PageHeader title="猫咪档案" description={desktop?'查看猫咪资料、体重和费用，小猫按母猫与窝次归档。':'查看猫咪近况与档案。'} actions={desktop&&<><button onClick={()=>setEditor({kind:'litter'})}>新建窝次</button><button className="primary" onClick={()=>setEditor({kind:'cat'})}>新建猫咪</button></>}/>
 {error&&<Notice error>{error} <button onClick={refresh}>重新加载</button></Notice>}{message&&<Notice>{message}</Notice>}
 {loading?<Notice>正在读取猫咪资料…</Notice>:error&&!cats.length?null:!cats.length?<div className="card"><Empty title="还没有猫咪档案">{desktop?'先建立母猫或公猫档案，再为母猫添加窝次和小猫。':'建档后，猫咪的近况会显示在这里。'}</Empty></div>:<>
 {cats.some(c=>c.role==='mother')&&<h2 className="cat-section-title">母猫与幼猫</h2>}
 {cats.filter(c=>c.role==='mother').map(m=><section className="cat-family" aria-label={m.name+'与小猫'} key={m.id}>{card(m)}{litters.filter(l=>l.mother_id===m.id).map(l=><div className="litter-group" key={l.id}><div className="litter-heading"><b>{l.name||'未命名窝次'}</b><span>{l.birth_date?l.birth_date+' 出生':'出生日期未填写'}</span></div><div className="card-grid">{cats.filter(k=>k.role==='kitten'&&k.motherId===m.id&&k.litterId===l.id).map(card)}</div>{!cats.some(k=>k.litterId===l.id)&&<p className="muted">此窝次还没有小猫档案。</p>}</div>)}</section>)}
 {cats.some(c=>c.role==='male')&&<><h2 className="cat-section-title">公猫档案</h2><div className="card-grid cat-male-list">{cats.filter(c=>c.role==='male').map(card)}</div></>}</>}
 {desktop&&editor&&<EditorDialog key={editor.kind+('cat'in editor?editor.cat?.id:'')} editor={editor} cats={cats} litters={litters} onClose={()=>setEditor(null)} onDone={done}/>}
 {view&&<Details cat={view} onClose={()=>setView(null)}/>}
 </Shell>;
}
function EditorDialog({editor,cats,litters,onClose,onDone}:{editor:Editor;cats:Cat[];litters:Litter[];onClose:()=>void;onDone:()=>void}){
 const existing=editor.kind==='cat'?editor.cat:undefined;const[name,setName]=useState(existing?.name||'');const[role,setRole]=useState(existing?.role||'mother');const[sex,setSex]=useState(existing?.sex||'');const[birth,setBirth]=useState(existing?.birthDate||'');const[mother,setMother]=useState(existing?.motherId||'');const[litter,setLitter]=useState(existing?.litterId||'');const[type,setType]=useState('deworm');const[date,setDate]=useState(today());const[next,setNext]=useState('');const[note,setNote]=useState('');const[busy,setBusy]=useState(false);const[error,setError]=useState('');
 async function save(e:React.FormEvent){e.preventDefault();if(busy)return;setError('');setBusy(true);try{
  if(editor.kind==='litter')await api.createLitter({motherId:mother,name:name.trim()||null,birthDate:birth||null});
  else if(editor.kind==='health')await api.registerHealth({catId:editor.cat.id,type,date,nextDueDate:next||null,note:note||null});
  else if(existing)await api.editCat(existing.id,{name:name.trim(),sex:sex||null,birthDate:birth||null},existing.version);
  else await api.createCat({name:name.trim(),role,sex:sex||null,birthDate:birth||null,motherId:role==='kitten'?mother:null,litterId:role==='kitten'?litter:null});
  onDone();
 }catch(e){setError((e as Error).message||'保存失败，填写内容已保留');setBusy(false);}}
 const mothers=cats.filter(c=>c.role==='mother');
 return <Modal title={editor.kind==='litter'?'新建窝次':editor.kind==='health'?'登记驱虫与疫苗 · '+editor.cat.name:existing?'编辑资料 · '+existing.name:'新建猫咪'} onClose={()=>{if(!busy)onClose();}}>
 <form onSubmit={save}>{error&&<Notice error>{error}</Notice>}<div className="form-grid">
 {editor.kind==='health'?<>
 <Field label="记录类型"><Select value={type} onChange={e=>setType(e.target.value)}><option value="deworm">驱虫</option><option value="vaccine">疫苗</option></Select></Field>
 <Field label="完成日期" hint={editor.cat.role==='kitten'?'按本猫舍约定：约45日龄驱虫、52日龄首针疫苗。只登记已完成的事项，不自动生成费用。':'只登记已完成的事项；费用根据实际花钱或用物资的记录计算。'}><input type="date" required max={today()} value={date} onChange={e=>setDate(e.target.value)}/></Field>
 <Field label="下次提醒日期（选填）" hint="填写后，会在到期时提醒。"><input type="date" min={date} value={next} onChange={e=>setNext(e.target.value)}/></Field>
 <Field label="备注（选填）"><input value={note} onChange={e=>setNote(e.target.value)}/></Field>
 </>:<>
 <Field label={editor.kind==='litter'?'窝次名称（选填）':'名称 *'}><input autoFocus required={editor.kind==='cat'} value={name} onChange={e=>setName(e.target.value)}/></Field>
 {editor.kind==='cat'&&!existing&&<Field label="类型"><Select value={role} onChange={e=>setRole(e.target.value as Cat['role'])}><option value="mother">母猫</option><option value="male">公猫</option><option value="kitten">小猫</option></Select></Field>}
 {editor.kind==='cat'&&<Field label="性别（选填）"><Select value={sex} onChange={e=>setSex(e.target.value)}><option value="">未填写</option><option value="母">母</option><option value="公">公</option></Select></Field>}
 <Field label="出生日期（选填）"><input type="date" max={today()} value={birth} onChange={e=>setBirth(e.target.value)}/></Field>
 {(editor.kind==='litter'||(!existing&&role==='kitten'))&&<Field label="所属母猫 *"><Select required value={mother} onChange={e=>{setMother(e.target.value);setLitter('');}}><option value="">请选择母猫</option>{mothers.map(m=><option key={m.id} value={m.id}>{m.name}</option>)}</Select></Field>}
 {editor.kind==='cat'&&!existing&&role==='kitten'&&<Field label="所属窝次 *" hint="先为母猫建立窝次，再为小猫建档。"><Select required value={litter} onChange={e=>setLitter(e.target.value)}><option value="">请选择窝次</option>{litters.filter(l=>l.mother_id===mother).map(l=><option key={l.id} value={l.id}>{l.name||l.birth_date||'未命名窝次'}</option>)}</Select></Field>}
 </>}</div><div className="form-actions"><button type="button" disabled={busy} onClick={onClose}>取消</button><button type="submit" className="primary" disabled={busy}>{busy?'保存中…':'保存'}</button></div></form>
 </Modal>;
}
function Details({cat,onClose}:{cat:Cat;onClose:()=>void}){
 const[data,setData]=useState<CatDetail|null>(null);const[error,setError]=useState('');
 useEffect(()=>{api.catDetail(cat.id).then(setData).catch(e=>setError(e.message));},[cat.id]);
 return <Modal title={cat.name+' · 档案详情'} onClose={onClose}>{error?<Notice error>{error}</Notice>:!data?<Notice>正在读取…</Notice>:<>
 <dl className="kv-grid"><div><dt>类型</dt><dd>{roleLabel(cat.role)}</dd></div><div><dt>已记录费用</dt><dd>{cat.costRecordCount>0?'¥'+(cat.costFen/100).toFixed(2):'暂无费用记录'}</dd></div></dl>
 <h3>体重记录</h3>{!data.weights.length?<p className="muted">暂无记录体重</p>:<ul className="detail-list">{data.weights.map(w=><li key={w.id}>{w.businessDate}<span className="detail-value">{w.weightGram} 克</span></li>)}</ul>}
 {data.health.length>0&&<><h3 className="section-label">驱虫与疫苗</h3><ul className="detail-list">{data.health.map(h=><li key={h.id}><div>{h.type==='deworm'?'驱虫':'疫苗'} · {h.date}{h.nextDueDate&&<small style={{display:'block'}}>下次：{h.nextDueDate}</small>}{h.note&&<small className="detail-note">{h.note}</small>}</div></li>)}</ul></>}
 </>}</Modal>;
}
