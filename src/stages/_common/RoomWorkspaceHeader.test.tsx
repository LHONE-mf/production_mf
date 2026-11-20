import React, {act} from 'react';
import {createRoot} from 'react-dom/client';
import {expect,it,vi} from 'vitest';
import {RoomWorkspaceHeader} from './RoomWorkspaceHeader';

it('gives the title full available width and collapses long room instructions without discarding them',async()=>{
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);
 const host=document.createElement('div');document.body.append(host);
 const root=createRoot(host);
 try{
  await act(async()=>root.render(<RoomWorkspaceHeader icon="📦" title="Склад материалов"
   description="Подтверждённые остатки, поступления и контролируемая выдача в производство."/>));
  const header=host.querySelector('header')!;
  const heading=header.querySelector('h2')!;
  const help=header.querySelector('details')!;
  const description=[...help.querySelectorAll('p')].find(p=>p.textContent?.includes('Подтверждённые остатки'))!;
  expect(heading.textContent).toBe('Склад материалов');
  expect(heading.className).toContain('flex-1');
  expect(heading.parentElement).toBe(header.firstElementChild);
  expect(help.open).toBe(false);
  expect(description.className).toContain('break-words');
  expect(help.textContent).toContain('подтверждение качества');
  await act(async()=>{help.querySelector('summary')!.click();});
  expect(help.open).toBe(true);
 }finally{await act(async()=>root.unmount());host.remove();vi.unstubAllGlobals();}
});
