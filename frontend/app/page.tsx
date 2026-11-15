'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Shell from '@/components/Shell';
import Link from 'next/link';
import {Empty,Icon,Notice,PageHeader} from '@/components/UI';
import { api, ApiError, stateLabel, type Todo, type InputState } from '@/lib/api';
import { transcribe } from '@/lib/recording-wav';

type RecordingGesture = {pointerId:number;clientY:number;currentTarget:HTMLButtonElement;preventDefault:()=>void};

type Binding = { kind: 'cat'; catId: string; label: string } | { kind: 'item'; targetItemId: string; label: string };
type Snapshot = { text: string; key: string; boundCatId: string | null; targetItemId: string | null; mediaIds: string[] };
type Persisted = { binding: Binding | null; draftText: string; mediaIds: string[]; snapshot: Snapshot | null; activeInputId: string | null };

const STORE_KEY = 'furops.composer.v1';
function loadPersisted(): Persisted {
  try {
    const p = JSON.parse(localStorage.getItem(STORE_KEY) ?? '{}');
    return { binding: p.binding ?? null, draftText: p.draftText ?? '', mediaIds: p.mediaIds ?? [], snapshot: p.snapshot ?? null, activeInputId: p.activeInputId ?? null };
  } catch {
    return { binding: null, draftText: '', mediaIds: [], snapshot: null, activeInputId: null };
  }
}

function toBase64(bytes: Uint8Array): string {
  let s = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) s += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(s);
}

export default function HomePage() {
  const [todos, setTodos] = useState<Todo[]>([]);
  const [loading,setLoading]=useState(true);
  const [loadError,setLoadError]=useState('');
  const [uploading,setUploading]=useState(false);
  const [bound, setBound] = useState<Binding | null>(null);
  const [persisted, setPersisted] = useState<Persisted>({ binding: null, draftText: '', mediaIds: [], snapshot: null, activeInputId: null });
  const [sendStatus, setSendStatus] = useState<'idle' | 'sending'>('idle');
  const [recentInputId, setRecentInputId] = useState<string | null>(null);
  const [feedbackDismissed, setFeedbackDismissed] = useState(false);
  const [current, setCurrent] = useState<InputState | null>(null);
  const [pollNonce, setPollNonce] = useState(0);
  const [voiceMsg, setVoiceMsg] = useState('');
  const [retrying,setRetrying]=useState(false);
  const [retryError,setRetryError]=useState('');
  const [sendError,setSendError]=useState('');
  const [recState, setRecState] = useState<'idle' | 'starting' | 'recording' | 'cancel' | 'transcribing'>('idle');
  const photoInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const startYRef = useRef(0);
  const cancelRef = useRef(false);
  const startingRef = useRef(false);
  const abortRef = useRef(false);
  const voiceSessionRef = useRef(0);
  const activePointerRef = useRef<number | null>(null);
  const transcribingRef = useRef(false);

  const { draftText, mediaIds, snapshot, activeInputId } = persisted;

  useEffect(() => { const p=loadPersisted();setPersisted(p);setBound(p.binding); }, []);

  const updatePersisted = (fn: (prev: Persisted) => Persisted) => {
    setPersisted(prev => {
      const next = fn(prev);
      localStorage.setItem(STORE_KEY, JSON.stringify(next));
      return next;
    });
  };

  const refresh = useCallback(async () => { try { setTodos(await api.todos());setLoadError(''); } catch { setLoadError('待办暂时无法读取，请重试'); } finally {setLoading(false);} }, []);
  useEffect(() => { refresh(); const t = setInterval(refresh, 3000); return () => clearInterval(t); }, [refresh]);

  useEffect(() => {
    if (!activeInputId) return;
    let stop = false;
    (async () => {
      while (!stop) {
        try {
          const s = await api.getInput(activeInputId);
          setCurrent(s);
          if (['completed', 'no_changes', 'needs_input', 'pending', 'failed', 'partial'].includes(s.state)) { refresh(); break; }
        } catch { /* 继续 */ }
        await new Promise(r => setTimeout(r, 2000));
      }
    })();
    return () => { stop = true; };
  }, [activeInputId, pollNonce, refresh]);

  const currentId = current?.id;
  const currentState = current?.state;
  // 成功反馈只属于本次发送；历史任务恢复后不重放成功提示。
  useEffect(() => {
    if (!currentId || currentId !== recentInputId || currentState !== 'completed') return;
    const timer = setTimeout(() => setFeedbackDismissed(true), 4000);
    return () => clearTimeout(timer);
  }, [currentId, currentState, recentInputId]);

  // 结果不明快照自动核实（同一请求标识）
  useEffect(() => {
    if (!snapshot || sendStatus === 'sending') return;
    let stop = false;
    const verify = async () => {
      if (stop) return;
      try {
        const input = await api.submit({ text: snapshot.text, idempotencyKey: snapshot.key, boundCatId: snapshot.boundCatId, targetItemId: snapshot.targetItemId, mediaIds: snapshot.mediaIds });
        updatePersisted(prev => {
          const next = { ...prev, snapshot: null, binding: null, activeInputId: input.id };
          next.mediaIds=prev.mediaIds.filter(id=>!snapshot.mediaIds.includes(id));
          if (prev.draftText.trim() === snapshot.text) next.draftText = '';
          return next;
        });
        setRecentInputId(input.id);setFeedbackDismissed(false);setCurrent(input);setBound(null);
      } catch(e) { if(e instanceof ApiError&&e.status>=400&&e.status<500&&![408,429].includes(e.status)){updatePersisted(prev=>({...prev,snapshot:null}));setSendError('未发出，内容已保留。'+e.message);} }
    };
    verify();
    const t = setInterval(verify, 5000);
    return () => { stop = true; clearInterval(t); };
  }, [snapshot, sendStatus]);

  async function submit() {
    const text = draftText.trim();
    if (!text || sendStatus === 'sending'||snapshot) return;
    const key = crypto.randomUUID();
    const boundCatId = bound?.kind === 'cat' ? bound.catId : null;
    const targetItemId = bound?.kind === 'item' ? bound.targetItemId : null;
    const ids = mediaIds;
    setSendError('');setRetryError('');setSendStatus('sending');
    updatePersisted(prev=>({...prev,snapshot:{text,key,boundCatId,targetItemId,mediaIds:ids}}));
    try {
      const input = await api.submit({ text, idempotencyKey: key, boundCatId, targetItemId, mediaIds: ids });
      updatePersisted(prev => {
        const next = { ...prev, snapshot: null, binding: null, activeInputId: input.id };
        next.mediaIds=prev.mediaIds.filter(id=>!ids.includes(id));
        if (prev.draftText.trim() === text) next.draftText = '';
        return next;
      });
      setRecentInputId(input.id);setFeedbackDismissed(false);
      setCurrent(input);
      setBound(null);
      setSendStatus('idle');
    } catch(e) {
      if(e instanceof ApiError&&e.status>=400&&e.status<500&&![408,429].includes(e.status)){updatePersisted(prev=>({...prev,snapshot:null}));setSendError('未发出，内容已保留。'+e.message);}
      // Snapshot was saved before sending; a refresh can verify the same request safely.
      setSendStatus('idle');
    }
  }

  async function retryFailed() {
    if (!activeInputId||retrying) return;setRetrying(true);setRetryError('');
    try { const s = await api.retry(activeInputId); setCurrent(s); setPollNonce(n => n + 1); } catch(e) {setRetryError((e as Error).message||'暂时无法重新整理，请稍后再试');}finally{setRetrying(false);}
  }

  function bindTodo(t: Todo) {
    const binding: Binding | null = t.type === 'weight_drop' && t.catId ? {kind:'cat',catId:t.catId,label:t.label} : t.type === 'needs_input' && t.targetItemId ? {kind:'item',targetItemId:t.targetItemId,label:t.label} : null;
    setBound(binding);
    updatePersisted(prev=>({...prev,binding}));
  }
  function unbind() { setBound(null); updatePersisted(prev=>({...prev,binding:null})); }

  // 按住录音；触摸中断、切到后台和上滑取消均停止音轨且不转写。
  function startRecord(e: RecordingGesture) {
    if (startingRef.current || transcribingRef.current || recorderRef.current) return;
    e.preventDefault();
    const session = ++voiceSessionRef.current;
    const button = e.currentTarget;
    activePointerRef.current = e.pointerId;
    try { button.setPointerCapture(e.pointerId); } catch { /* 部分浏览器不支持捕获 */ }
    startYRef.current = e.clientY;
    cancelRef.current = false;
    abortRef.current = false;
    startingRef.current = true;
    setVoiceMsg('');
    setRecState('starting');
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      startingRef.current = false;
      activePointerRef.current = null;
      setRecState('idle');
      setVoiceMsg('当前浏览器无法录音，请输入文字');
      return;
    }
    navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
      if (session !== voiceSessionRef.current || abortRef.current || activePointerRef.current === null) {
        stream.getTracks().forEach(t => t.stop());
        return;
      }
      startingRef.current = false;
      let rec: MediaRecorder;
      try {
        const mime = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm'].find(type => MediaRecorder.isTypeSupported(type));
        rec = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
      } catch {
        stream.getTracks().forEach(t => t.stop());
        activePointerRef.current = null;
        setRecState('idle');
        setVoiceMsg('无法启动录音，请直接输入文字');
        return;
      }
      const chunks: Blob[] = [];
      rec.ondataavailable = ev => { if (ev.data.size) chunks.push(ev.data); };
      rec.onstop = async () => {
        stream.getTracks().forEach(t => t.stop());
        if (recorderRef.current === rec) recorderRef.current = null;
        if (session !== voiceSessionRef.current || cancelRef.current) {
          if (session === voiceSessionRef.current) setRecState('idle');
          return;
        }
        transcribingRef.current = true;
        setRecState('transcribing');
        try {
          const text = await transcribe(new Blob(chunks, { type: rec.mimeType }));
          updatePersisted(prev => ({ ...prev, draftText: prev.draftText ? `${prev.draftText} ${text}` : text }));
        } catch (err: unknown) {
          setVoiceMsg((err as Error).message || '语音转写失败，请直接输入文字');
        } finally {
          transcribingRef.current = false;
          setRecState('idle');
        }
      };
      rec.onerror = () => {
        cancelRef.current = true;
        stream.getTracks().forEach(t => t.stop());
        recorderRef.current = null;
        activePointerRef.current = null;
        setRecState('idle');
        setVoiceMsg('录音中断，请重试或输入文字');
      };
      recorderRef.current = rec;
      try { rec.start(); setRecState('recording'); } catch {
        stream.getTracks().forEach(t => t.stop());
        recorderRef.current = null;
        activePointerRef.current = null;
        setRecState('idle');
        setVoiceMsg('无法启动录音，请直接输入文字');
      }
    }).catch(() => {
      if (session !== voiceSessionRef.current) return;
      startingRef.current = false;
      activePointerRef.current = null;
      setVoiceMsg('未获得麦克风权限，请在 Safari 网站设置中允许麦克风后重试');
      setRecState('idle');
    });
  }
  function moveRecord(e: React.PointerEvent<HTMLButtonElement>) {
    if (activePointerRef.current !== e.pointerId) return;
    cancelRef.current = e.clientY < startYRef.current - 50;
    if (!startingRef.current) setRecState(cancelRef.current ? 'cancel' : 'recording');
  }
  function endRecord(e: Pick<RecordingGesture,'pointerId'|'currentTarget'>, cancelled = false) {
    if (activePointerRef.current !== e.pointerId) return;
    activePointerRef.current = null;
    if (cancelled) cancelRef.current = true;
    if (startingRef.current) {
      abortRef.current = true;
      startingRef.current = false;
      ++voiceSessionRef.current; // 迟到的麦克风权限结果不能启动下一次录音。
      setRecState('idle');
    } else {
      const rec = recorderRef.current;
      if (rec?.state === 'recording') rec.stop();
      else setRecState('idle');
    }
    try { if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* 已释放 */ }
  }
  useEffect(() => {
    const cancel = () => {
      if (activePointerRef.current === null && !startingRef.current && !recorderRef.current) return;
      cancelRef.current = true;
      abortRef.current = true;
      startingRef.current = false;
      activePointerRef.current = null;
      ++voiceSessionRef.current;
      const rec = recorderRef.current;
      recorderRef.current = null;
      if (rec?.state === 'recording') rec.stop();
      setRecState('idle');
    };
    const onVisibility = () => { if (document.hidden) cancel(); };
    window.addEventListener('pagehide', cancel);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('pagehide', cancel);
      document.removeEventListener('visibilitychange', onVisibility);
      cancel();
    };
  }, []);

  async function onPhoto(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if(file.size>10*1024*1024){setVoiceMsg('照片不能超过 10 MB，请换一张较小的照片');return;}
    if(mediaIds.length>=8){setVoiceMsg('每条记录最多添加8张照片，请先发送当前内容');return;}
    setUploading(true);
    try {
      const base64 = toBase64(new Uint8Array(await file.arrayBuffer()));
      const media = await api.uploadMedia(file.type||(/\.heif$/i.test(file.name)?'image/heif':/\.heic$/i.test(file.name)?'image/heic':/\.png$/i.test(file.name)?'image/png':/\.jpe?g$/i.test(file.name)?'image/jpeg':''), base64);
      updatePersisted(prev => ({ ...prev, mediaIds: [...prev.mediaIds, media.id] }));
      setVoiceMsg('');
    } catch (err) { setVoiceMsg((err as Error).message || '上传失败，请重新选择照片'); } finally {setUploading(false);}
  }

  return (
    <Shell>
      <div className="home-workspace">
      <PageHeader title="今日待办" description="处理待办，也可以随时记录新情况。" />
      {loadError && <Notice error>{loadError}<button onClick={refresh}>重新加载</button></Notice>}
      <section className="card tint" aria-labelledby="todo-heading">
        <div className="section-head"><h2 id="todo-heading">待处理事项</h2>{todos.length>0&&<span className="pill">{todos.length} 件</span>}</div>
        {loading ? <Notice>正在读取待办…</Notice> : loadError&&todos.length===0 ? null : todos.length === 0 ? <Empty title="目前没有待处理事项">可以在下方记录新的情况。</Empty> :
        <div className="todo-list" role="region" aria-label="待处理事项，向上滑动查看更多" tabIndex={0}>{todos.map(t=>{
          const bindable=(t.type==='weight_drop'&&t.catId)||(t.type==='needs_input'&&t.targetItemId);
          const selected=bound&&((t.type==='weight_drop'&&bound.kind==='cat'&&bound.catId===t.catId)||(t.type==='needs_input'&&bound.kind==='item'&&bound.targetItemId===t.targetItemId));
          const content=<><span className={`dot ${t.priority===1?'red':t.priority<=3?'orange':'yellow'}`} aria-hidden="true"/><span className="grow"><b>{t.label}</b><small>{t.detail}</small></span><span className="todo-action">{selected?'正在处理':bindable?'处理此事':'查看资料'} →</span></>;
          const key=`${t.type}-${t.catId??t.itemId??t.targetItemId??t.label}-${t.label}`;
          return bindable?<button type="button" className={'todo-item'+(selected?' selected':'')} key={key} aria-pressed={!!selected} onClick={()=>{bindTodo(t);document.getElementById('record-text')?.focus();}}>{content}</button>:<Link className="todo-item" key={key} href={t.type==='health_due'?'/cats#cat-'+t.catId:'/items#item-'+t.itemId}>{content}</Link>;
        })}</div>}

        <div className="composer">
          <div className="bind"><label className="composer-heading" htmlFor="record-text">{bound?<>正在处理：{bound.label}</>:'自由记录'}</label>{bound&&<button className="ghost" onClick={unbind}>取消选择</button>}</div>
          <textarea id="record-text" value={draftText} rows={2}
            placeholder={recState==='starting'?'正在开启麦克风，请按住…':recState==='recording'?'正在听…松手转文字':recState==='cancel'?'松手取消':recState==='transcribing'?'正在转文字…':'说说刚刚发生了什么，例如：红圈今天体重245克。'}
            onChange={e=>updatePersisted(prev=>({...prev,draftText:e.target.value}))}
          />
          {mediaIds.length>0&&<div>{mediaIds.map((id,i)=><span className="attachment" key={id}>照片 {i+1}<button aria-label={`移除照片 ${i+1}`} onClick={()=>updatePersisted(prev=>({...prev,mediaIds:prev.mediaIds.filter(x=>x!==id)}))}>×</button></span>)}</div>}
          <div className="composer-tools"><div className="actions">
            <button type="button" aria-label="上传照片" onClick={()=>photoInputRef.current?.click()} disabled={uploading||sendStatus==='sending'}><Icon name="photo"/>上传照片</button>
            <input ref={photoInputRef} type="file" accept="image/jpeg,image/png,image/heic,image/heif" hidden onChange={onPhoto}/>
            <button type="button" className="camera-button" aria-label="拍照" onClick={()=>cameraInputRef.current?.click()} disabled={uploading||sendStatus==='sending'}><Icon name="photo"/>拍照</button>
            <input ref={cameraInputRef} type="file" accept="image/jpeg,image/png,image/heic,image/heif" capture="environment" hidden onChange={onPhoto}/>
            <button onPointerDown={startRecord} onPointerMove={moveRecord} onPointerUp={e=>endRecord(e)}
              onPointerCancel={e=>endRecord(e,true)} onLostPointerCapture={e=>endRecord(e,true)}
              onContextMenu={e=>e.preventDefault()}
              onKeyDown={e=>{if((e.key===' '||e.key==='Enter')&&!e.repeat){startRecord({pointerId:-1,clientY:0,currentTarget:e.currentTarget,preventDefault:()=>e.preventDefault()});}}}
              onKeyUp={e=>{if(e.key===' '||e.key==='Enter'){e.preventDefault();endRecord({pointerId:-1,currentTarget:e.currentTarget});}}}
              onBlur={e=>{if(activePointerRef.current===-1)endRecord({pointerId:-1,currentTarget:e.currentTarget},true);}} aria-label="按住说话，松手转文字，上滑取消"
              disabled={recState==='transcribing'||uploading||sendStatus==='sending'} className={'voice-button'+(recState==='recording'?' recording':'')}>
              <Icon name="mic"/>{recState==='starting'?'开启中':recState==='transcribing'?'转写中':recState==='cancel'?'松手取消':recState==='recording'?'松手转文字':'按住说话'}</button>
          </div><button className="primary" onClick={submit} disabled={sendStatus==='sending'||!!snapshot||!draftText.trim()||uploading||recState!=='idle'}>{sendStatus==='sending'?'发送中…':'发送'}<Icon name="arrow"/></button></div>
          {uploading&&<div className="status" role="status">正在上传照片…</div>}
          {voiceMsg&&<div className="status fail" role="alert">{voiceMsg}</div>}
          {snapshot&&<div className="status" role="status">正在确认是否发送成功，内容已保留。</div>}
          {sendError&&<div className="status fail" role="alert">{sendError}</div>}
          {retryError&&<div className="status fail" role="alert">{retryError}</div>}
          {current&&!snapshot&&sendStatus==='idle'&&!sendError&&(current.state!=='completed'||(current.id===recentInputId&&!feedbackDismissed))&&<div className={'status feedback'+(current.state==='completed'?' success':['failed','partial'].includes(current.state)?' fail':'')} role="status">{current.state==='completed'?<>✓ 已记录</>:current.state==='received'?'已收到，正在整理…':current.state==='processing'?'正在整理…':stateLabel(current.state)}{(current.state==='failed'||current.state==='partial')&&<button disabled={retrying} onClick={retryFailed}>{retrying?'正在重试…':'重新整理'}</button>}</div>}
        </div>
      </section>
      </div>
    </Shell>
  );
}
