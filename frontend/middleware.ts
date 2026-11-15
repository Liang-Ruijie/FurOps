import { NextResponse, type NextRequest } from 'next/server';
import{accessAllowed}from './lib/local-access';

// 前后端同源转发：/api/* 原样转发到后端 node:http（BACKEND_URL，默认 127.0.0.1:3001）。
// 本地开发用；上线（阶段 4）换云托管环境变量，仍不改代码。
export async function middleware(request: NextRequest): Promise<NextResponse> {
  const hosts=(process.env.LOCAL_ALLOWED_HOSTS||'localhost:3000,127.0.0.1:3000').split(',');
  const session=process.env.LOCAL_SESSION_TOKEN||'';
  const host=request.headers.get('host')||'';
  const isApi=request.nextUrl.pathname.startsWith('/api/');
  if(!hosts.includes(host))return NextResponse.json({error:{code:'FORBIDDEN',message:'访问地址不正确'}},{status:403});
  if(!isApi){
    const response=NextResponse.next();
    if(session.length>=32)response.cookies.set('furops-local',session,{httpOnly:true,sameSite:'strict',secure:request.nextUrl.protocol==='https:',path:'/'});
    return response;
  }
  if(!accessAllowed(host,request.headers.get('origin'),request.headers.get('sec-fetch-site'),request.method,request.cookies.get('furops-local')?.value,{hosts,session}))return NextResponse.json({error:{code:'FORBIDDEN',message:'请刷新工作台页面后再试'}},{status:403});
  const backend = (process.env.BACKEND_URL ?? 'http://127.0.0.1:3001').replace(/\/+$/, '');
  const url = new URL(request.nextUrl.pathname + request.nextUrl.search, backend);

  const headers = new Headers(request.headers);
  headers.set('host', url.host);
  headers.set('x-furops-proxy-token',process.env.LOCAL_PROXY_TOKEN||'');
  // 逐跳头/长度头由 fetch 重算，避免 invalid content-length
  for (const h of ['content-length', 'content-encoding', 'transfer-encoding', 'connection', 'keep-alive', 'te', 'trailer', 'upgrade']) headers.delete(h);

  const body = request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.arrayBuffer();
  const upstream = await fetch(url, { method: request.method, headers, body, redirect: 'manual' });

  return new NextResponse(upstream.body, { status: upstream.status, headers: upstream.headers });
}

export const config = { matcher: ['/', '/cats', '/items', '/records', '/api/:path*'] };
