# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: mobile.spec.mjs >> one account layout at 390
- Location: tests\browser\mobile.spec.mjs:21:35

# Error details

```
Test timeout of 30000ms exceeded.
```

```
Error: locator.click: Test timeout of 30000ms exceeded.
Call log:
  - waiting for locator('dialog').getByRole('button', { name: /sign in|log in/i })

```

# Page snapshot

```yaml
- generic [ref=e1]:
  - generic [ref=e3]:
    - link "Skip to content" [ref=e4] [cursor=pointer]:
      - /url: "#main-content"
    - banner [ref=e5]:
      - generic [ref=e6]:
        - button "St. Marylebone Table Tracker" [ref=e7] [cursor=pointer]:
          - strong [ref=e8]: St. Marylebone
          - generic [ref=e9]: Table Tracker
        - button "Menu" [ref=e11] [cursor=pointer]
    - navigation "Mobile primary" [ref=e13]:
      - button "Ranks" [ref=e14] [cursor=pointer]
      - button "History" [ref=e19] [cursor=pointer]
      - button "Champions" [ref=e25] [cursor=pointer]
      - button "Seasons" [ref=e33] [cursor=pointer]
    - main [ref=e37]:
      - generic [ref=e38]:
        - generic [ref=e39]:
          - heading "Ranks" [level=1] [ref=e40]
          - generic [ref=e41]: Current season
        - navigation "Ranks views" [ref=e42]:
          - button "Standings" [ref=e43] [cursor=pointer]
          - button "Stats" [ref=e44] [cursor=pointer]
      - region "Standings" [ref=e45]:
        - generic [ref=e46]:
          - generic [ref=e47]:
            - generic [ref=e48]:
              - generic [ref=e49]: Players
              - generic [ref=e50]: "4"
            - button "Games This Month 0" [ref=e51] [cursor=pointer]:
              - generic [ref=e52]: Games This Month
              - generic [ref=e53]: "0"
            - generic [ref=e54]:
              - generic [ref=e55]: Top Points
              - generic [ref=e56]: "13"
          - generic [ref=e57]:
            - generic [ref=e58]:
              - generic [ref=e59]: Rankings — September 2026
              - generic [ref=e60]:
                - generic "Connecting…" [ref=e61]
                - generic [ref=e62]: …
            - generic [ref=e64]:
              - button "— Dan 0W 0L · — · — · —" [ref=e65] [cursor=pointer]:
                - generic [ref=e66]: —
                - generic [ref=e67]:
                  - generic [ref=e68]: Dan
                  - generic [ref=e70]:
                    - generic [ref=e71]: 0W
                    - generic [ref=e72]: 0L
                    - text: · — · — ·
                - generic [ref=e73]: —
              - button "— Cara 0W 0L · — · — · —" [ref=e74] [cursor=pointer]:
                - generic [ref=e75]: —
                - generic [ref=e76]:
                  - generic [ref=e77]: Cara
                  - generic [ref=e79]:
                    - generic [ref=e80]: 0W
                    - generic [ref=e81]: 0L
                    - text: · — · — ·
                - generic [ref=e82]: —
              - button "— Ben 0W 0L · — · — · —" [ref=e83] [cursor=pointer]:
                - generic [ref=e84]: —
                - generic [ref=e85]:
                  - generic [ref=e86]: Ben
                  - generic [ref=e88]:
                    - generic [ref=e89]: 0W
                    - generic [ref=e90]: 0L
                    - text: · — · — ·
                - generic [ref=e91]: —
              - button "— Alice 0W 0L · — · — · —" [ref=e92] [cursor=pointer]:
                - generic [ref=e93]: —
                - generic [ref=e94]:
                  - generic [ref=e95]: Alice
                  - generic [ref=e97]:
                    - generic [ref=e98]: 0W
                    - generic [ref=e99]: 0L
                    - text: · — · — ·
                - generic [ref=e100]: —
  - dialog "League details" [ref=e101]:
    - generic [ref=e102]:
      - button "Close dialog" [ref=e103] [cursor=pointer]
      - generic [ref=e108]:
        - generic [ref=e109]: Admin Access
        - generic [ref=e110]:
          - generic [ref=e111]: Username
          - textbox "Username…" [ref=e112]: admin
        - generic [ref=e113]:
          - generic [ref=e114]: Passphrase
          - textbox "Passphrase…" [active] [ref=e115]: test-password
        - button "Login" [ref=e116] [cursor=pointer]
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
  22 |  await page.setViewportSize({width,height:900});await fixtures(page);await page.goto('/');
  23 |  await page.getByRole('button',{name:'Menu',exact:true}).click();
  24 |  await page.getByRole('button',{name:'Admin sign in',exact:true}).click();
  25 |  await page.locator('dialog input').nth(0).fill('admin');await page.locator('dialog input').nth(1).fill('test-password');
> 26 |  await page.locator('dialog').getByRole('button',{name:/sign in|log in/i}).click();
     |                                                                            ^ Error: locator.click: Test timeout of 30000ms exceeded.
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