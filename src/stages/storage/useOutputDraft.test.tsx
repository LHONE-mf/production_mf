import React,{act,StrictMode,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {inventoryOutbox} from '../../core/sync/inventoryOutbox';
import {useOutputDraft} from '../_common/useOutputDraft';
function Probe({label,draftKey,epoch}:{label:string;draftKey:string;epoch:string}){
 const draft=useOutputDraft(draftKey,{epoch,quantity:''}),[result,setResult]=useState('');
 return <section data-probe={label}>{draft.row&&<><input readOnly value={draft.row.fields.quantity}/><button data-edit={label} onClick={()=>draft.edit({...draft.row!.fields,quantity:label==='second'?'8':'7'})}>Записать</button><button data-check={label} onClick={()=>void draft.flush().then(r=>setResult(JSON.stringify(r.fields))).catch(e=>setResult(String(e)))}>Проверить</button></>}{draft.error&&<p role="alert">{draft.error}</p>}<output>{result}</output></section>;
}
let node:HTMLDivElement,root:ReturnType<typeof createRoot>;
beforeEach(async()=>{vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);await inventoryOutbox.open();node=document.createElement('div');root=createRoot(node);});
afterEach(async()=>{await act(async()=>root.unmount());vi.unstubAllGlobals();inventoryOutbox.close();await inventoryOutbox.delete();});
async function settle(check:()=>void|Promise<void>){await vi.waitFor(async()=>{await act(async()=>{await new Promise(r=>setTimeout(r,10));});await check();});}
async function click(selector:string){await act(async()=>{node.querySelector<HTMLButtonElement>(selector)!.click();});}
it('retains edited quantity and original epoch under StrictMode replay, changed props and reopen',async()=>{
 await act(async()=>root.render(<StrictMode><Probe label="count" draftKey="original" epoch="old-history"/></StrictMode>));await settle(()=>expect(node.querySelector('input')).not.toBeNull());
 await click('[data-edit="count"]');await settle(async()=>expect((await inventoryOutbox.receivingDrafts.get('original'))?.fields).toEqual({epoch:'old-history',quantity:'7'}));
 await act(async()=>root.render(<StrictMode><Probe label="count" draftKey="original" epoch="new-history"/></StrictMode>));await click('[data-check="count"]');await settle(()=>expect(node.querySelector('output')!.textContent).toContain('old-history'));
 await act(async()=>root.unmount());root=createRoot(node);await act(async()=>root.render(<StrictMode><Probe label="reopened" draftKey="original" epoch="another-history"/></StrictMode>));
 await settle(()=>expect(node.querySelector('input')?.value).toBe('7'));expect((await inventoryOutbox.receivingDrafts.get('original'))?.fields.epoch).toBe('old-history');
});
it('surfaces concurrent stale-form conflict and preserves the first original count without rebasing',async()=>{
 await act(async()=>root.render(<><Probe label="first" draftKey="shared" epoch="history"/><Probe label="second" draftKey="shared" epoch="history"/></>));await settle(()=>expect(node.querySelectorAll('input')).toHaveLength(2));
 await click('[data-edit="first"]');await settle(async()=>expect((await inventoryOutbox.receivingDrafts.get('shared'))?.fields.quantity).toBe('7'));
 await click('[data-edit="second"]');await settle(()=>expect(node.querySelector('[role="alert"]')).not.toBeNull());await click('[data-check="second"]');await settle(()=>expect(node.querySelector('[data-probe="second"] output')!.textContent).toContain('не сохранён полностью'));
 expect((await inventoryOutbox.receivingDrafts.get('shared'))?.fields).toEqual({epoch:'history',quantity:'7'});
});
