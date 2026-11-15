// FurOps 本机启动：API、后台整理与四页工作台一起启动、一起退出。
import{randomBytes}from 'node:crypto';
import{networkInterfaces}from 'node:os';
import {spawn} from 'node:child_process';
import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname,resolve} from 'node:path';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const backend=resolve(root,'backend');
const frontend=resolve(root,'frontend');
const apiPort=process.env.PORT||'3001';
const frontendPort=process.env.FRONTEND_PORT||'3000';
const localHosts=['localhost','127.0.0.1',...Object.values(networkInterfaces()).flat().filter(x=>x&&x.family==='IPv4'&&!x.internal&&/^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)/.test(x.address)).map(x=>x.address)].map(h=>h+':'+frontendPort);
const env={...process.env,LOCAL_PROXY_TOKEN:randomBytes(32).toString('hex'),LOCAL_SESSION_TOKEN:randomBytes(32).toString('hex'),LOCAL_ALLOWED_HOSTS:localHosts.join(','),DB_PATH:process.env.DB_PATH||resolve(root,'data/furops.db'),PORT:apiPort};
const key=resolve(root,'data/tls/server.key');
const cert=resolve(root,'data/tls/server.pem');
const tls=existsSync(key)&&existsSync(cert);
const frontArgs=[resolve(frontend,'node_modules/next/dist/bin/next'),'dev','-H','0.0.0.0','-p',frontendPort];
if(tls)frontArgs.push('--experimental-https','--experimental-https-key',key,'--experimental-https-cert',cert);
const procs=[
 spawn(process.execPath,['--env-file-if-exists=.env','src/server/index.ts'],{cwd:backend,env,stdio:'inherit'}),
 spawn(process.execPath,['--env-file-if-exists=.env','src/worker/index.ts'],{cwd:backend,env,stdio:'inherit'}),
 spawn(process.execPath,frontArgs,{cwd:frontend,env:{...env,BACKEND_URL:'http://127.0.0.1:'+apiPort},stdio:'inherit'}),
];
let closing=false;
function shutdown(code){if(closing)return;closing=true;for(const p of procs)p.kill('SIGTERM');setTimeout(()=>process.exit(code),700);}
process.on('SIGINT',()=>shutdown(0));
process.on('SIGTERM',()=>shutdown(0));
for(const p of procs){p.on('error',()=>{console.error('启动失败，请检查依赖是否安装、端口是否已占用。');shutdown(1);});p.on('exit',c=>{if(!closing)shutdown(c??1);});}
console.log('FurOps 工作台：'+(tls?'https':'http')+'://localhost:'+frontendPort+'；手机访问需同一 Wi-Fi。');
