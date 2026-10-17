import {readFileSync} from "node:fs";
import {webcrypto} from "node:crypto";
import vm from "node:vm";
import {parseHTML} from "linkedom";

export async function flush(){
  for(let iteration=0;iteration<8;iteration++)await new Promise(resolve=>setImmediate(resolve));
}
export async function startUI(directory, respond, hash=""){
  const {document,window}=parseHTML(readFileSync(new URL("index.html",directory),"utf8"));
  const calls=[];
  const location={origin:"https://portfolio.example",hash};
  class TestFormData{
    constructor(form){this.form=form;}
    *[Symbol.iterator](){
      for(const field of this.form.querySelectorAll("[name]")){
        if(field.disabled||(["checkbox","radio"].includes(field.type)&&!field.checked))continue;
        yield [field.name,field.value??""];
      }
    }
  }
  for(const form of document.querySelectorAll("form")){
    Object.defineProperty(form,"elements",{get:()=>Object.fromEntries([...form.querySelectorAll("[name]")].map(field=>[field.name,field]))});
  }
  for(const target of document.querySelectorAll("dialog")){
    target.showModal=()=>target.setAttribute("open","");
    target.close=()=>target.removeAttribute("open");
  }
  const context=vm.createContext({
    document,window,location,navigator:{onLine:true},console,
    URL,URLSearchParams,Blob,Date,Intl,Uint8Array,crypto:webcrypto,FormData:TestFormData,
    setTimeout:()=>0,clearTimeout:()=>{},setInterval:()=>0,addEventListener:()=>{},
    matchMedia:()=>({matches:false}),
    fetch:async(path,options)=>{
      calls.push({path,...options,body:options.body?JSON.parse(options.body):undefined});
      const result=await respond(path,options);
      return {ok:!result?.error,json:async()=>result?.error?{detail:result.error}:result};
    }
  });
  if(directory.href.includes("MealBridge")){
    vm.runInContext(readFileSync(new URL("geolocation.js",directory),"utf8"),context);
  }
  vm.runInContext(readFileSync(new URL("app.js",directory),"utf8"),context);
  await flush();
  async function click(selector){
    const target=document.querySelector(selector);
    if(!target)throw new Error("Missing control: "+selector);
    target.dispatchEvent(new window.Event("click",{bubbles:true,cancelable:true}));
    await flush();
  }
  async function submit(selector){
    const form=document.querySelector(selector);
    const event=new window.Event("submit",{bubbles:true,cancelable:true});
    Object.defineProperty(event,"submitter",{value:form.querySelector("button:not([type=button])")});
    form.dispatchEvent(event);
    await flush();
  }
  return {document,context,calls,click,submit,window,location};
}

