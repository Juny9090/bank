const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const originalFetch = global.fetch;
const originalKey = process.env.OPENAI_API_KEY;
afterEach(() => { global.fetch = originalFetch; if (originalKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = originalKey; });
function handler() { delete require.cache[require.resolve('../api/analyze')]; return require('../api/analyze'); }
const valid = () => ({ month:'2026-11',income:50000,expense:5000,balance:45000,allowance:50000,daysRemaining:21,count:2,categories:[{name:'식비',amount:5000}] });
async function request(fn, body=valid(), extra={}) {
 const res={headers:{},code:200,setHeader(k,v){this.headers[k]=v},status(n){this.code=n;return this},json(data){this.data=data;return this}};
 await fn({method:'POST',headers:{host:'bank.test',origin:'https://bank.test','content-type':'application/json'},body,...extra},res); return res;
}
test('method, origin, invalid input and oversized body rejected',async()=>{
 const fn=handler();assert.equal((await request(fn,valid(),{method:'GET'})).code,405);
 assert.equal((await request(fn,valid(),{headers:{host:'bank.test',origin:'https://other.test'}})).code,403);
 for(const body of [{...valid(),expense:-1},{...valid(),categories:[{name:'식비',amount:1}]},'bad JSON']) assert.equal((await request(fn,body)).code,400);
 assert.equal((await request(fn,'x'.repeat(20001))).code,413);
});
test('missing key gives setup guidance without upstream call',async()=>{delete process.env.OPENAI_API_KEY;global.fetch=()=>assert.fail('must not call');const r=await request(handler());assert.equal(r.code,503);assert.match(r.data.error,/OPENAI_API_KEY/)});
test('only summary whitelist is sent; response, cooldown, secret isolation',async()=>{
 process.env.OPENAI_API_KEY='fake-test-key';let sent;
 global.fetch=async(url,options)=>{sent=JSON.parse(options.body);return {ok:true,json:async()=>({status:'completed',output:[{type:'message',content:[{type:'output_text',text:'분석 완료'}]}]})}};
 const fn=handler(),r=await request(fn,{...valid(),memo:'private memo',transactions:[{memo:'private'}]});
 assert.equal(r.code,200);assert.equal(r.data.answer,'분석 완료');assert.equal(sent.store,false);assert.equal(sent.max_output_tokens,700);
 assert.ok(!sent.input.includes('private'));assert.equal(JSON.parse(sent.input).dailyBudget,2142);assert.ok(!JSON.stringify(r.data).includes('fake-test-key'));
 assert.equal((await request(fn)).code,429);
});
test('upstream errors and timeout produce safe messages',async()=>{
 process.env.OPENAI_API_KEY='fake-test-key';
 for(const status of [401,429,500]){global.fetch=async()=>({ok:false,status});const r=await request(handler());assert.equal(r.code,status===429?429:502);assert.ok(r.data.error)}
 global.fetch=async()=>{throw Object.assign(new Error('secret internal message'),{name:'TimeoutError'})};const r=await request(handler());assert.equal(r.code,504);assert.ok(!r.data.error.includes('secret'));
});
function frontend(){
 const nodes={};function el(id){return nodes[id]??={value:'',checked:false,innerHTML:'',textContent:'',style:{},classList:{add(){},remove(){},replace(){},toggle(){}},listeners:{},addEventListener(t,f){this.listeners[t]=f},click(){return this.listeners.click?.({target:this,currentTarget:this})}}}
 class Clock extends Date{constructor(...a){super(...(a.length?a:['2026-11-10T12:00:00+09:00']))}static now(){return new Date('2026-11-10T12:00:00+09:00').getTime()}}
 const ctx={Date:Clock,AbortSignal,document:{getElementById:el,querySelectorAll:()=>[],querySelector:()=>el('nav')},localStorage:{getItem:()=>null,setItem(){}},setTimeout:f=>f(),alert(){},confirm:()=>true};ctx.window=ctx;vm.createContext(ctx);const code=fs.readFileSync(require('node:path').join(__dirname,'../index.html'),'utf8').match(/<script>([\s\S]*?)<\/script>/)[1];vm.runInContext(code,ctx);return {ctx,run:s=>vm.runInContext(s,ctx),el};
}
test('frontend omits memos/future transactions and calculates remaining days',()=>{
 const {run}=frontend();run(`transactions=[{id:1,type:'income',amount:50000,date:'2026-11-01',category:'용돈',memo:'secret'},{id:2,type:'expense',amount:5000,date:'2026-11-10',category:'식비',memo:'secret'},{id:3,type:'expense',amount:10000,date:'2026-11-20',category:'식비'}]`);
 const summary=JSON.parse(run('JSON.stringify(buildAISummary())'));assert.equal(summary.count,2);assert.equal(summary.balance,45000);assert.equal(summary.daysRemaining,21);assert.ok(!JSON.stringify(summary).includes('secret'));
});
test('frontend consent, empty state, successful request, cache and safe text',async()=>{
 const {ctx,run,el}=frontend();let calls=0;ctx.fetch=async()=>{calls++;return {ok:true,json:async()=>({answer:'<img src=x>조언'})}};
 await el('btn-ai-analyze').click();assert.equal(calls,0);assert.match(el('ai-status').textContent,/동의/);
 el('ai-consent').checked=true;await el('btn-ai-analyze').click();assert.equal(calls,0);assert.match(el('ai-status').textContent,/기록/);
 run(`transactions=[{id:1,type:'income',amount:10000,date:'2026-11-10',category:'용돈'}]`);
 await el('btn-ai-analyze').click();assert.equal(calls,1);assert.equal(el('ai-answer').textContent,'<img src=x>조언');assert.equal(el('ai-answer').innerHTML,'');assert.equal(el('btn-ai-analyze').disabled,false);
 await el('btn-ai-analyze').click();assert.equal(calls,1);
 run('transactions[0].amount=20000');await el('btn-ai-analyze').click();assert.equal(calls,1);assert.match(el('ai-status').textContent,/1분/);
});
