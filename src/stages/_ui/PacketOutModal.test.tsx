import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
import {it,expect,vi} from 'vitest';
import {PacketQrView} from './PacketOutModal';
import {decodePacketFromQr,toQrChunks} from '../../transfer/packet';
it('renders a large saved snapshot in compatible bounded QR frames with explicit navigation',async()=>{
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);
 const packet={v:1,type:'fill-run',payload:{source:'a'.repeat(6000)},from:'test',ts:1};
 const encoded='LIP:'+btoa(JSON.stringify(packet));const frames=toQrChunks(encoded);
 let decoded=null;for(const frame of [...frames].reverse())decoded=decodePacketFromQr(frame)??decoded;expect(decoded).toEqual(packet);
 const node=document.createElement('div');document.body.appendChild(node);const root=createRoot(node);
 try{
  await act(async()=>root.render(<PacketQrView text={encoded}/>));expect(node.querySelector('svg')).not.toBeNull();expect(node.textContent).toContain(`Кадр 1 из ${frames.length}`);
  await act(async()=>[...node.querySelectorAll('button')].find(b=>b.textContent==='Следующий кадр')!.click());expect(node.textContent).toContain(`Кадр 2 из ${frames.length}`);
  await act(async()=>root.render(<PacketQrView text="LIP:small"/>));expect(node.textContent).not.toContain('Кадр');expect(node.querySelector('svg')).not.toBeNull();
 }finally{await act(async()=>root.unmount());node.remove();vi.unstubAllGlobals();}
});
