import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
import {it,expect,vi} from 'vitest';
const test=vi.hoisted(()=>({started:undefined as undefined|(()=>void),stopped:vi.fn(),cleared:vi.fn(),instance:undefined as undefined|{isScanning:boolean}}));
vi.mock('html5-qrcode',()=>({Html5Qrcode:class {isScanning=false;constructor(){test.instance=this;}start(){return new Promise<void>(resolve=>{test.started=()=>{this.isScanning=true;resolve();};});}async stop(){test.stopped();this.isScanning=false;}clear(){test.cleared();}}}));
import {QrScanner} from './QrScanner';
it('stops a camera that finishes starting after the scanner unmounts',async()=>{
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host);await act(async()=>root.render(<QrScanner onClose={()=>{}} onResult={()=>{}}/>));await act(async()=>root.unmount());test.started!();await act(async()=>{await new Promise(r=>setTimeout(r,0));});expect(test.stopped).toHaveBeenCalledTimes(1);expect(test.instance?.isScanning).toBe(false);host.remove();
});
