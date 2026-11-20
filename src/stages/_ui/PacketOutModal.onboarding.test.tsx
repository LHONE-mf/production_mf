import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
import {it,expect,vi} from 'vitest';
import {setWorkshopKey} from '../../core/security';

vi.mock('../../transfer/packet',()=>({
 encodePacket:vi.fn(async()=>localStorage.getItem('workshop-hmac-key-v1')?'LIP:signed-packet':Promise.reject(new Error('Нет ключа'))),
 toQrChunks:vi.fn((value:string)=>[value]),
}));
vi.mock('../../transfer/useBluetooth',()=>({
 useBluetooth:()=>({available:false,status:'idle',logLines:[],stop:vi.fn(),startReceiving:vi.fn(),send:vi.fn()}),
}));
import {PacketOutModal} from './PacketOutModal';

it('rebuilds a pending handoff after the same-phone workshop key has been entered explicitly',async()=>{
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);
 localStorage.removeItem('workshop-hmac-key-v1');
 const node=document.createElement('div');document.body.appendChild(node);
 const root=createRoot(node);
 try{
  await act(async()=>root.render(<PacketOutModal packet={{v:1,type:'mix-batch',payload:{id:'saved-mix'},from:'operator',ts:1}} onClose={()=>{}}/>));
  expect(node.textContent).toContain('на этом телефоне не задан общий ключ');
  expect(node.textContent).not.toContain('Скопировать текст пакета');
  const input=node.querySelector<HTMLInputElement>('[aria-label="Общий ключ цеха для передачи"]')!;
  await act(async()=>{
   Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input,'test-workshop-key-20');
   input.dispatchEvent(new Event('input',{bubbles:true}));
  });
  await act(async()=>[...node.querySelectorAll('button')].find(b=>b.textContent==='Сохранить ключ и подготовить передачу')!.click());
  await act(async()=>[...node.querySelectorAll('button')].find(b=>b.textContent?.includes('Текст'))!.click());
  await vi.waitFor(()=>expect(node.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('LIP:signed-packet'));
  expect(localStorage.getItem('workshop-hmac-key-v1')).toBe('test-workshop-key-20');
 }finally{
  await act(async()=>root.unmount());
  node.remove();localStorage.removeItem('workshop-hmac-key-v1');vi.unstubAllGlobals();
 }
});
