import {it,expect} from 'vitest';
import {inventoryLabelHtml} from './inventoryLabelPrinting';
it('prints only an inert, escaped typed label and rejects active SVG/external resources',()=>{
 const org='11111111-1111-4111-8111-111111111111',id='22222222-2222-4222-8222-222222222222',svg='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path fill="#000000" d="M0 0h10v10H0z"/></svg>';
 const html=inventoryLabelHtml(org,'container',id,'<img src=x onerror=alert(1)> & Lot',svg);expect(html).toContain('&lt;img');expect(html).not.toContain('<img');expect(html).toContain('Content-Security-Policy');expect(html).toContain(`production-mf:v1:${org}:container:${id}`);
 for(const bad of ['<svg><script>alert(1)</script></svg>','<svg onload="alert(1)"/>','<svg><image href="https://example.com"/></svg>','<svg><path fill="url(https://example.com)"/></svg>'])expect(()=>inventoryLabelHtml(org,'container',id,'Label',bad)).toThrow();
});
