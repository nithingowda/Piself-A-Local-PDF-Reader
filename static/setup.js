'use strict';
(async()=>{
 try{
  const r=await fetch('/api/auth/setup-status',{cache:'no-store'});
  const data=await r.json();
  if(!data.setup_required)location.replace('/login.html');
 }catch{document.getElementById('error').textContent='Could not check setup status.';}
})();
document.getElementById('setup').addEventListener('submit',async event=>{
 event.preventDefault();
 const error=document.getElementById('error'),button=event.target.querySelector('button');
 const username=document.getElementById('username').value,password=document.getElementById('password').value,confirm=document.getElementById('confirm').value;
 if(password!==confirm){error.textContent='Passwords do not match.';return;}
 button.disabled=true;error.textContent='';
 try{
  const r=await fetch('/api/auth/setup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username,password})});
  const result=await r.json();
  if(!r.ok)throw Error(result.error||'Setup failed.');
  location.replace('/login.html');
 }catch(e){error.textContent=e.message;}finally{button.disabled=false;document.getElementById('password').value='';document.getElementById('confirm').value='';}
});