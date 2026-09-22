# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: mobile.spec.mjs >> one account layout at 1440
- Location: tests\browser\mobile.spec.mjs:21:35

# Error details

```
Error: page.goto: net::ERR_CONNECTION_REFUSED at http://127.0.0.1:5181/
Call log:
  - navigating to "http://127.0.0.1:5181/", waiting until "load"

```

# Test source

```ts
  1  | import { test, expect } from '@playwright/test';
  2  | const user={id:'00000000-0000-4000-8000-000000000001',aud:'authenticated',role:'authenticated',email:'admin@internal.foosballmmr.local'};
  3  | const profiles=[{user_id:user.id,username:'admin',role:'sysadmin',call_sign:'admin',active:true,created_at:'2026-09-01T12:00:00Z'}, {user_id:'00000000-0000-4000-8000-000000000002',username:'referee',role:'referee',call_sign:'referee',active:true,created_at:'2026-09-01T12:00:00Z'}];
  4  | const state={players:['Alice','Ben','Cara','Dan'].map((name,i)=>({id:i+1,name,mmr:1000,pts:10+i,preferredRole:'FLEX',position:[],wins:0,losses:0,streak:0})),games:[],seasons:[],finals:{},_v:1,rules:'Test rules'};
  5  | async function fixtures(page){
  6  |  await page.routeWebSocket(/supabase/,(ws)=>ws.close());
  7  |  await page.route('**/*', async route=>{
  8  |   const url=new URL(route.request().url());
  9  |   if(url.hostname==='127.0.0.1')return route.continue();
  10 |   if(!url.hostname.includes('supabase'))return route.abort();
  11 |   let body={};
  12 |   if(url.pathname.includes('/auth/v1/token')) body={access_token:'test-token',refresh_token:'test-refresh',expires_in:3600,token_type:'bearer',user};
  13 |   else if(url.pathname.includes('/auth/v1/user'))body=user;
  14 |   else if(url.pathname.endsWith('/app_state'))body={state};
  15 |   else if(url.pathname.endsWith('/profiles'))body=url.searchParams.has('user_id')?profiles[0]:profiles;
  16 |   else if(url.pathname.includes('/rpc/'))body={};
  17 |   else body=[];
  18 |   return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(body)});
  19 |  });
  20 | }
  21 | for(const width of [390,800,1440])test('one account layout at '+width,async({page})=>{
> 22 |  await page.setViewportSize({width,height:900});await fixtures(page);await page.goto('/');
     |                                                                                 ^ Error: page.goto: net::ERR_CONNECTION_REFUSED at http://127.0.0.1:5181/
  23 |  await page.getByRole('button',{name:'Menu',exact:true}).click();
  24 |  await page.getByRole('button',{name:'Admin sign in',exact:true}).click();
  25 |  await page.locator('dialog input').nth(0).fill('admin');await page.locator('dialog input').nth(1).fill('test-password');
  26 |  await page.locator('dialog').getByRole('button',{name:/sign in|log in/i}).click();
  27 |  await expect(page.locator('dialog')).toHaveCount(0);
  28 |  await page.goto('/#view=admin&task=accounts');
  29 |  // Session persists through navigation, all network data remains intercepted.
  30 |  await expect(page.getByText('Existing Logins',{exact:true})).toBeVisible();
  31 |  if(width<=980){await expect(page.locator('.acct-cards')).toBeVisible();await expect(page.locator('.acct-table')).toBeHidden();}
  32 |  else{await expect(page.locator('.acct-table')).toBeVisible();await expect(page.locator('.acct-cards')).toBeHidden();}
  33 |  await expect(page.locator('body')).not.toHaveCSS('overflow','hidden');
  34 | });
  35 | 
```