import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import {startUI,flush} from "./ui_test_helper.mjs";

const directory=new URL("./",import.meta.url);
test("An earlier in-flight session response cannot restore identity after logout",async()=>{
  const fixture=fixtures();fixture.login();
  let hold=false,release;
  const respond=async(path,options)=>{
    const result=await fixture.respond(path,options);
    if(path==="/api/me"&&hold){hold=false;return new Promise(resolve=>{release=()=>resolve(result);});}
    return result;
  };
  const ui=await startUI(directory,respond);
  hold=true;
  const pending=vm.runInContext("load()",ui.context);
  await flush();
  await ui.click("#logout");
  release();await pending;await flush();
  assert.equal(ui.document.querySelector("#identity").textContent,"訪客");
});
function fixtures(){
  let signedIn=false,broken=false;
  const respond=async path=>{
    if(path==="/api/logout"){signedIn=false;broken=true;return {};}
    if(path==="/api/me")return signedIn?{nickname:"私人暱稱"}:null;
    if(path==="/api/my-events")return [];
    if(path.startsWith("/api/events?"))return broken?{error:"測試網路失敗"}:[];
    if(path==="/api/notifications")return [{id:1,message:"私人通知內容",created:Date.now()/1000,seen:false,event:"event1"}];
    throw new Error("Unexpected request "+path);
  };
  return {respond,login:()=>{signedIn=true;}};
}
test("Guest discovery renders a date strip and does not read private endpoints",async()=>{
  const ui=await startUI(directory,fixtures().respond);
  assert.match(ui.document.querySelector("main").textContent,/這週，約一場/);
  assert.equal(ui.document.querySelectorAll(".day").length,8);
  assert.ok(ui.calls.every(call=>!call.path.includes("notifications")&&!call.path.includes("my-events")));
});
test("Sport controls reach the actual server query",async()=>{
  const ui=await startUI(directory,fixtures().respond);
  await ui.click('[data-sport="羽球"]');
  const request=ui.calls.filter(call=>call.path.startsWith("/api/events?")).at(-1);
  assert.equal(new URL(request.path,"https://portfolio.example").searchParams.get("sport"),"羽球");
});
test("Create draft survives navigation without local storage",async()=>{
  const fixture=fixtures();fixture.login();
  const ui=await startUI(directory,fixture.respond);
  await ui.click('[data-screen="create"]');
  const title=ui.document.querySelector('[name="title"]');title.value="期末羽球臨打";
  title.dispatchEvent(new ui.window.Event("input",{bubbles:true}));
  await ui.click('[data-screen="discover"]');
  await ui.click('[data-screen="create"]');
  assert.equal(ui.document.querySelector('[name="title"]').value,"期末羽球臨打");
});
test("Logout removes notification content and create drafts even on refresh failure",async()=>{
  const fixture=fixtures();fixture.login();
  const ui=await startUI(directory,fixture.respond);
  await ui.click('[data-action="notifications"]');
  assert.match(ui.document.querySelector("#notifications-dialog").textContent,/私人通知內容/);
  await ui.click('[data-close="notifications-dialog"]');
  await ui.click("#logout");
  assert.equal(ui.document.querySelector("#notifications-dialog").textContent,"");
  assert.equal(ui.document.querySelector("#identity").textContent,"訪客");
});
