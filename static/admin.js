'use strict';
let csrf='';
const error=document.getElementById('error');
async function request(url,data){
 const r=await fetch(url,data===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json','X-PiShelf-CSRF':csrf},body:JSON.stringify(data)});
 if(r.status===401){location.replace('/login.html');throw Error('Login required');}
 const result=await r.json();
 if(!r.ok)throw Error(result.error||'Request failed');
 return result;
}
async function load(){
 const me=await request('/api/auth/me');if(me.role!=='admin')throw Error('Administrator account required.');
 csrf=me.csrf;
 const users=await request('/api/admin/users'),list=document.getElementById('users');list.replaceChildren();
 for(const user of users){
  const li=document.createElement('li');
  li.append(document.createTextNode(user.username+' — '+user.role+' — '+(user.enabled?'enabled':'disabled')+' '));
  for(const [label,action] of [[user.enabled?'Disable':'Enable',user.enabled?'disable':'enable'],['Reset password','reset-password'],['Delete','delete']]){
   const button=document.createElement('button');button.textContent=label;
   button.onclick=async()=>{
    if(action==='delete'&&!confirm('Permanently delete account '+user.username+'?'))return;
    const data={action,id:user.id};
    if(action==='reset-password'){
     const dialog=document.createElement('dialog');
     const form=document.createElement('form');form.method='dialog';
     const field=document.createElement('input');field.type='password';field.minLength=12;field.required=true;field.placeholder='New password (12+ characters)';field.autocomplete='new-password';
     const submit=document.createElement('button');submit.type='submit';submit.textContent='Reset password';
     const cancel=document.createElement('button');cancel.type='button';cancel.textContent='Cancel';cancel.onclick=()=>dialog.close();
     form.append(field,submit,cancel);dialog.append(form);document.body.append(dialog);
     dialog.addEventListener('close',()=>dialog.remove(),{once:true});
     form.onsubmit=async event=>{event.preventDefault();try{await request('/api/admin/users',{...data,password:field.value});dialog.close();await load();}catch(e){error.textContent=e.message;}};
     dialog.showModal();return;
    }
    try{await request('/api/admin/users',data);await load();}catch(e){error.textContent=e.message;}
   };li.append(button);
  }list.append(li);
 }
}
document.getElementById('create').addEventListener('submit',async event=>{
 event.preventDefault();const form=event.target;
 try{await request('/api/admin/users',{action:'create',username:form.elements.namedItem('username').value,password:form.elements.namedItem('password').value,role:form.elements.namedItem('role').value});form.reset();error.textContent='';await load();}
 catch(e){error.textContent=e.message;}
});
load().catch(e=>error.textContent=e.message);