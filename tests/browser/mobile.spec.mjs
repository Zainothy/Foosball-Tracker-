import { test, expect } from '@playwright/test';
const user={id:'00000000-0000-4000-8000-000000000001',aud:'authenticated',role:'authenticated',email:'admin@internal.foosballmmr.local'};
const profiles=[{user_id:user.id,username:'admin',role:'sysadmin',call_sign:'admin',active:true,created_at:'2026-09-01T12:00:00Z'}, {user_id:'00000000-0000-4000-8000-000000000002',username:'referee',role:'referee',call_sign:'referee',active:true,created_at:'2026-09-01T12:00:00Z'}];
const state={players:['Alice','Ben','Cara','Dan'].map((name,i)=>({id:i+1,name,mmr:1000,pts:10+i,preferredRole:'FLEX',position:[],wins:0,losses:0,streak:0})),games:[],seasons:[],finals:{},_v:1,rules:'Test rules'};
async function fixtures(page){
 await page.routeWebSocket(/supabase/,(ws)=>ws.close());
 await page.route('**/*', async route=>{
  const url=new URL(route.request().url());
  if(url.hostname==='127.0.0.1')return route.continue();
  if(!url.hostname.includes('supabase'))return route.abort();
  let body={};
  if(url.pathname.includes('/auth/v1/token')) body={access_token:'test-token',refresh_token:'test-refresh',expires_in:3600,token_type:'bearer',user};
  else if(url.pathname.includes('/auth/v1/user'))body=user;
  else if(url.pathname.endsWith('/app_state'))body={state};
  else if(url.pathname.endsWith('/profiles'))body=url.searchParams.has('user_id')?profiles[0]:profiles;
  else if(url.pathname.includes('/rpc/'))body={};
  else body=[];
  return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(body)});
 });
}
for(const width of [390,800,1440])test('one account layout at '+width,async({page})=>{
 await page.setViewportSize({width,height:900});await fixtures(page);await page.goto('/');
 await page.getByRole('button',{name:'Menu',exact:true}).click();
 await page.getByRole('button',{name:'Admin sign in',exact:true}).click();
 await page.locator('dialog input').nth(0).fill('admin');await page.locator('dialog input').nth(1).fill('test-password');
 await page.locator('dialog').getByRole('button',{name:/sign in|log in/i}).click();
 await expect(page.locator('dialog')).toHaveCount(0);
 await page.goto('/#view=admin&task=accounts');
 // Session persists through navigation, all network data remains intercepted.
 await expect(page.getByText('Existing Logins',{exact:true})).toBeVisible();
 if(width<=980){await expect(page.locator('.acct-cards')).toBeVisible();await expect(page.locator('.acct-table')).toBeHidden();}
 else{await expect(page.locator('.acct-table')).toBeVisible();await expect(page.locator('.acct-cards')).toBeHidden();}
 await expect(page.locator('body')).not.toHaveCSS('overflow','hidden');
});
