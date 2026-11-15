'use client';
import Link from 'next/link';
import {usePathname} from 'next/navigation';
import {Icon} from './UI';
export default function Shell({children}:{children:React.ReactNode}){
 const pathname=usePathname();
 const items=[{href:'/',label:'今日待办',icon:'home' as const},{href:'/cats',label:'猫咪档案',icon:'cats' as const},{href:'/items',label:'物资管理',icon:'items' as const},{href:'/records',label:'事件记录',icon:'records' as const}];
 return <div className="shell"><a className="skip-link" href="#main">跳到主要内容</a><aside className="sidebar"><div className="brand">FurOps<small>猫舍 AI 管家</small></div><nav className="nav" aria-label="主要导航">{items.map(it=><Link key={it.href} href={it.href} aria-current={pathname===it.href?'page':undefined} className={pathname===it.href?'active':''}><Icon name={it.icon}/>{it.label}</Link>)}</nav></aside><main id="main">{children}</main></div>;
}
