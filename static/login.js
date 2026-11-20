'use strict';
(async()=>{
 try{
  const response=await fetch('/api/auth/setup-status',{cache:'no-store'});
  if(response.ok&&(await response.json()).setup_required)location.replace('/setup.html');
 }catch{ /* Login remains available if setup status cannot be read. */ }
})();
document.getElementById('login').addEventListener('submit',async event=>{
 event.preventDefault();
 const error=document.getElementById('error'),button=event.target.querySelector('button');
 error.textContent='';button.disabled=true;
 try{
  const r=await fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},credentials:'same-origin',body:JSON.stringify({username:document.getElementById('username').value,password:document.getElementById('password').value})});
  const data=await r.json();
  if(!r.ok)throw Error(data.error||'Sign-in failed');
  location.replace('/');
 }catch(e){error.textContent=e.message;}finally{button.disabled=false;document.getElementById('password').value='';}
});