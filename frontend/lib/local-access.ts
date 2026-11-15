export function accessAllowed(host:string,origin:string|null,site:string|null,method:string,session:string|undefined,opts:{hosts:string[];session:string}):boolean{
 if(!opts.hosts.includes(host)||site==='cross-site')return false;
 if(origin){let u:URL;try{u=new URL(origin);}catch{return false;}if(!['http:','https:'].includes(u.protocol)||u.host!==host)return false;}
 if(!['GET','HEAD','OPTIONS'].includes(method)&&!origin)return false;
 return session===opts.session&&opts.session.length>=32;
}
