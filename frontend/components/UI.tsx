'use client';
import { useEffect, useId, useRef } from 'react';

export function PageHeader({title,description,actions}:{title:string;description:string;actions?:React.ReactNode}){
 return <header className="page-header"><div><h1>{title}</h1><p>{description}</p></div>{actions&&<div className="actions">{actions}</div>}</header>;
}
export function Notice({children,error=false}:{children:React.ReactNode;error?:boolean}){
 return <div className={error?'notice error':'notice'} role={error?'alert':'status'}>{children}</div>;
}
export function Empty({title,children}:{title:string;children?:React.ReactNode}){
 return <div className="empty"><span className="empty-mark" aria-hidden="true">○</span><h3>{title}</h3>{children&&<p>{children}</p>}</div>;
}
export function Field({label,children,hint}:{label:string;children:React.ReactNode;hint?:string}){
 return <label className="field"><span>{label}</span>{children}{hint&&<small>{hint}</small>}</label>;
}
export function Modal({title,onClose,children}:{title:string;onClose:()=>void;children:React.ReactNode}){
 const ref=useRef<HTMLDialogElement>(null);const id=useId();
 useEffect(()=>{const d=ref.current;const previous=document.activeElement as HTMLElement|null;const overflow=document.body.style.overflow;document.body.style.overflow='hidden';d?.showModal();return()=>{d?.close();document.body.style.overflow=overflow;if(previous?.isConnected)previous.focus({preventScroll:true});};},[]);
 return <dialog ref={ref} aria-labelledby={id} onCancel={e=>{e.preventDefault();onClose();}}><div className="modal-head"><h2 id={id}>{title}</h2><button type="button" className="icon-button" onClick={onClose} aria-label="关闭窗口"><svg className="ui-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg></button></div>{children}</dialog>;
}
export function Icon({name}:{name:'home'|'cats'|'items'|'records'|'mic'|'photo'|'arrow'|'calendar'}){
 const paths={calendar:'M4 5h16v16H4z M4 10h16 M8 3v4 M16 3v4',home:'M4 5h16v14H4z M8 9h8 M8 13h5',cats:'M5 10V4l5 4h4l5-4v6c3 8-17 8-14 0 M9 12h.01 M15 12h.01 M11 15h2',items:'M4 8l8-4 8 4v12H4z M4 8l8 4 8-4 M12 12v8',records:'M6 3h12v18H6z M9 8h6 M9 12h6 M9 16h4',mic:'M9 5a3 3 0 016 0v6a3 3 0 01-6 0z M6 10v1a6 6 0 0012 0v-1 M12 17v4 M9 21h6',photo:'M3 7h4l2-3h6l2 3h4v13H3z M16 13a4 4 0 11-8 0 4 4 0 018 0',arrow:'M5 12h14 M13 6l6 6-6 6'};
 return <svg className="ui-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]}/></svg>;
}
