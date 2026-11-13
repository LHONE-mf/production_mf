import React,{act} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {afterEach,expect,it,vi} from 'vitest';
import {db} from '../../core/db';
import {StageId} from '../../core/types';
import {StageJournal} from './StageJournal';

let root:Root|undefined;
let host:HTMLDivElement|undefined;
afterEach(async()=>{
 if(root)await act(async()=>root!.unmount());
 root=undefined;host?.remove();host=undefined;
 db.close();await db.delete();vi.unstubAllGlobals();
});
function enter(input:HTMLInputElement,value:string){
 Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input,value);
 input.dispatchEvent(new Event('input',{bubbles:true}));
}
it('preserves generic notes when saving fails and does not split decimal commas',async()=>{
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);
 await db.open();
 const onAdd=vi.fn().mockRejectedValueOnce(new Error('TEST-storage-unavailable')).mockResolvedValueOnce(undefined);
 host=document.createElement('div');document.body.appendChild(host);root=createRoot(host);
 await act(async()=>{root!.render(<StageJournal stage={StageId.STORAGE} onAdd={onAdd} canAdd />);});
 const inputs=host.querySelectorAll<HTMLInputElement>('input');
 await act(async()=>{
  enter(inputs[0],'TEST-operator note');
  enter(inputs[1],'Вязкость=1,25; Партия=TEST-12');
  enter(inputs[2],'Отслоение края');
 });
 const save=host.querySelector('button')!;
 await act(async()=>{save.click();});
 await vi.waitFor(()=>expect(host!.querySelector('[role="alert"]')?.textContent).toContain('TEST-storage-unavailable'));
 expect(inputs[0].value).toBe('TEST-operator note');
 expect(inputs[1].value).toBe('Вязкость=1,25; Партия=TEST-12');
 expect(onAdd).toHaveBeenCalledWith({
  summary:'TEST-operator note',params:{'Вязкость':'1,25','Партия':'TEST-12'},defects:'Отслоение края',
 });
 await act(async()=>{save.click();});
 await vi.waitFor(()=>expect(host!.querySelector('[role="status"]')?.textContent).toContain('Сохранено локально'));
 expect(onAdd).toHaveBeenCalledTimes(2);
 expect(inputs[0].value).toBe('');
});
