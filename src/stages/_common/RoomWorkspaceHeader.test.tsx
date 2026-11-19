import React, {act} from 'react';
import {createRoot} from 'react-dom/client';
import {expect,it,vi} from 'vitest';
import {RoomWorkspaceHeader} from './RoomWorkspaceHeader';

it('keeps the whole room description and title out of the badge column on small screens',async()=>{
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);
 const host=document.createElement('div');document.body.append(host);
 const root=createRoot(host);
 try{
  await act(async()=>root.render(<RoomWorkspaceHeader icon="📦" title="Склад материалов"
   description="Подтверждённые остатки, поступления и контролируемая выдача в производство."/>));
  const header=host.querySelector('header')!;
  const heading=header.querySelector('h2')!;
  const description=[...header.querySelectorAll('p')].find(p=>p.textContent?.includes('Подтверждённые остатки'))!;
  const badge=[...header.querySelectorAll('span')].find(s=>s.textContent==='Этап производства')!;
  expect(heading.textContent).toBe('Склад материалов');
  expect(description.parentElement).toBe(header); // independent full-width paragraph
  expect(heading.parentElement).not.toBe(badge.parentElement);
  expect(description.className).toContain('break-words');
 }finally{await act(async()=>root.unmount());host.remove();vi.unstubAllGlobals();}
});
