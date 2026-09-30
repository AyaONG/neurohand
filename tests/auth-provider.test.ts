import { expect, it, vi } from 'vitest';
import { googleProviderState } from '../src/auth-provider';
it.each([[true,'enabled'],[false,'disabled'],[undefined,'unavailable']] as const)('strictly checks google=%s without treating unknown settings as ready',async(value,expected)=>{
 const request=vi.fn(async()=>({ok:true,json:async()=>({external:{google:value}})}));
 expect(await googleProviderState('https://example.supabase.co','sb_publishable_example',request as unknown as typeof fetch)).toBe(expected);
 expect(request.mock.calls[0]).toEqual(['https://example.supabase.co/auth/v1/settings',expect.objectContaining({headers:{apikey:'sb_publishable_example'},credentials:'omit',cache:'no-store'})]);
});
it('bounds network/body waits, treats HTTP/parse/network failures as unavailable',async()=>{
 for(const response of [()=>Promise.reject(TypeError('offline')),async()=>({ok:false}),async()=>({ok:true,json:async()=>{throw Error('not json');}})]) {
  expect(await googleProviderState('https://example.supabase.co','sb_publishable_example',response as typeof fetch)).toBe('unavailable');
 }
 expect(await googleProviderState('https://example.supabase.co','sb_publishable_example',(()=>new Promise(()=>{})) as typeof fetch,5)).toBe('unavailable');
});
